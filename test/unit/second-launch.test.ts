import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  boxAnswerOf,
  handleSecondInstance,
  IGNORED_LINE,
  LAUNCH_PROFILE_PREFIX,
  launchHasDisplay,
  launchSocketPath,
  losingLaunchAsks,
  storedWebAccessOn,
  pidAlive,
  privateLaunchProfile,
  runSecondLaunch,
  SECOND_LAUNCH_ANSWER_ENV,
  SECOND_LAUNCH_ASK_MS,
  secondInstanceAction,
  serverAddress,
  serverBoxMessage,
  serverBoxOptions,
  socketAsk,
  sweepLaunchProfiles,
  testBoxAnswer,
  type BoxAnswer
} from '../../src/main/second-launch'
import { decideServerMode } from '../../src/main/server-mode'
import { fallbackSocketDir } from '../../src/main/paths'
import { parseRequest, type Reply } from '../../src/shared/protocol'

/** A `web.status` result as a server answers it (only the fields read here). */
function status(server: boolean, gateway: unknown = { state: 'listening', bind: '0.0.0.0', port: 7000, origin: 'https://box.lan:7000' }): unknown {
  return { server, enabled: true, mode: 'link', bind: '0.0.0.0', port: 7000, externalOrigin: null, gateway, devices: [] }
}

describe('the decision table', () => {
  it('a launch has a display when it would run as a desktop', () => {
    const linux = (env: Record<string, string>, argv: string[] = ['/bin/cc']) =>
      launchHasDisplay(decideServerMode({ platform: 'linux', env, argv, execPath: '/bin/cc' }))
    expect(linux({ DISPLAY: ':0' })).toBe(true)
    expect(linux({ WAYLAND_DISPLAY: 'wayland-1' })).toBe(true)
    expect(linux({})).toBe(false)
    // `--server` from an `ssh -X` shell is the server's own shell asking.
    expect(linux({ DISPLAY: ':0' }, ['/bin/cc', '--server'])).toBe(false)
    expect(launchHasDisplay(decideServerMode({ platform: 'darwin', env: {}, argv: ['/bin/cc'], execPath: '/bin/cc' }))).toBe(true)
  })

  it('a server primary ignores only a launch with a display; a desktop primary opens every one', () => {
    const rows: Array<[boolean, boolean | undefined, 'open' | 'ignore']> = [
      [true, true, 'ignore'],
      [true, false, 'open'],
      // Data from another build (no `display`) reads as before.
      [true, undefined, 'open'],
      [false, true, 'open'],
      [false, false, 'open'],
      [false, undefined, 'open']
    ]
    for (const [server, display, want] of rows) expect(secondInstanceAction({ server, display }), `${server} ${display}`).toBe(want)
  })

  it('a losing launch asks the socket only with a display, on Linux, with web access on in the data dir', () => {
    expect(losingLaunchAsks({ platform: 'linux', display: true, webAccessOn: true })).toBe(true)
    expect(losingLaunchAsks({ platform: 'linux', display: false, webAccessOn: true })).toBe(false)
    expect(losingLaunchAsks({ platform: 'darwin', display: true, webAccessOn: true })).toBe(false)
    expect(losingLaunchAsks({ platform: 'win32', display: true, webAccessOn: true })).toBe(false)
    // Off: no server can hold the dir (a server run writes it on), so the launch quits at once.
    expect(losingLaunchAsks({ platform: 'linux', display: true, webAccessOn: false })).toBe(false)
  })

  it("reads web access on from app.json's text; missing, damaged or anything but true is off", () => {
    expect(storedWebAccessOn(() => JSON.stringify({ webAccess: { enabled: true, port: 7330 } }))).toBe(true)
    expect(storedWebAccessOn(() => JSON.stringify({ webAccess: { enabled: false } }))).toBe(false)
    expect(storedWebAccessOn(() => JSON.stringify({ webAccess: { enabled: 'yes' } }))).toBe(false)
    expect(storedWebAccessOn(() => JSON.stringify({}))).toBe(false)
    expect(storedWebAccessOn(() => '{not json')).toBe(false)
    expect(
      storedWebAccessOn(() => {
        throw new Error('ENOENT')
      })
    ).toBe(false)
  })
})

describe('handleSecondInstance (the primary)', () => {
  function run(server: boolean, display: boolean | undefined, opens: boolean) {
    const calls = { open: [] as string[][], focusAny: 0, logs: [] as string[] }
    handleSecondInstance(
      { server, display, argv: ['/bin/cc', '/work/a'], cwd: '/home/me' },
      {
        open: (argv) => {
          calls.open.push([...argv])
          return opens
        },
        focusAny: () => calls.focusAny++,
        log: (l) => calls.logs.push(l)
      }
    )
    return calls
  }

  it('a server ignores the argv of a launch with a display: it opens nothing and logs a line', () => {
    const calls = run(true, true, true)
    expect(calls.open).toEqual([])
    expect(calls.focusAny).toBe(0)
    expect(calls.logs).toEqual([IGNORED_LINE])
  })

  it('a server opens the path of a launch with no display, as any second launch', () => {
    const calls = run(true, false, true)
    expect(calls.open).toEqual([['/bin/cc', '/work/a']])
    expect(calls.logs).toEqual([])
  })

  it('desktop meets desktop is unchanged: open, else focusAny', () => {
    expect(run(false, true, true)).toMatchObject({ open: [['/bin/cc', '/work/a']], focusAny: 0, logs: [] })
    expect(run(false, true, false)).toMatchObject({ focusAny: 1, logs: [] })
    expect(run(false, undefined, false)).toMatchObject({ focusAny: 1 })
  })
})

describe('serverAddress', () => {
  it('reads only an answer that says server mode', () => {
    expect(serverAddress(status(false))).toBeUndefined()
    for (const bad of [undefined, null, 'server', 7, [], { server: 'true' }, { server: 1 }]) expect(serverAddress(bad)).toBeUndefined()
  })

  it('names the origin links point at when listening, else the bind and port', () => {
    expect(serverAddress(status(true))).toBe('https://box.lan:7000')
    expect(serverAddress(status(true, { state: 'failed', reason: 'port in use' }))).toBe('0.0.0.0:7000')
    expect(serverAddress({ server: true, bind: '::', port: 7000, gateway: { state: 'off' } })).toBe('[::]:7000')
    expect(serverAddress({ server: true })).toBe('an unknown address')
  })

  it('shows another process text as plain, capped text', () => {
    const origin = `http://x\u0007\n\u001b[31m${'y'.repeat(500)}`
    const shown = serverAddress(status(true, { state: 'listening', origin }))!
    expect(Array.from(shown).some((ch) => (ch.codePointAt(0) ?? 0) < 0x20)).toBe(false)
    expect(shown.length).toBe(200)
  })

  it('the box text and buttons: Cancel is the default and the cancel answer', () => {
    expect(serverBoxMessage('http://h:1')).toBe('cc-cockpit runs in server mode on this machine (web access at http://h:1)')
    const options = serverBoxOptions('m')
    expect(options.buttons).toEqual(['Stop', 'Cancel'])
    expect(options.defaultId).toBe(1)
    expect(options.cancelId).toBe(1)
    expect(boxAnswerOf(0)).toBe('stop')
    expect(boxAnswerOf(1)).toBe('cancel')
    expect(boxAnswerOf(-1)).toBe('cancel')
  })
})

describe('testBoxAnswer', () => {
  it('the env answer only in a test run', () => {
    expect(testBoxAnswer({ [SECOND_LAUNCH_ANSWER_ENV]: 'stop' }, true)).toBe('stop')
    expect(testBoxAnswer({ [SECOND_LAUNCH_ANSWER_ENV]: 'cancel' }, true)).toBe('cancel')
    expect(testBoxAnswer({ [SECOND_LAUNCH_ANSWER_ENV]: 'stop' }, false)).toBeUndefined()
    expect(testBoxAnswer({ [SECOND_LAUNCH_ANSWER_ENV]: 'yes' }, true)).toBeUndefined()
    expect(testBoxAnswer({}, true)).toBeUndefined()
  })
})

describe('runSecondLaunch (the losing launch)', () => {
  function deps(statusReply: Reply | undefined, opts: { testAnswer?: BoxAnswer; box?: () => Promise<BoxAnswer> } = {}) {
    const asked: string[] = []
    const boxes: string[] = []
    const logs: string[] = []
    return {
      asked,
      boxes,
      logs,
      deps: {
        ask: (cmd: 'web.status' | 'web.stop') => {
          asked.push(cmd)
          return Promise.resolve(cmd === 'web.status' ? statusReply : ({ id: 1, ok: true, result: {} } as Reply))
        },
        testAnswer: opts.testAnswer,
        box: (message: string) => {
          boxes.push(message)
          return opts.box ? opts.box() : Promise.resolve<BoxAnswer>('cancel')
        },
        log: (l: string) => logs.push(l)
      }
    }
  }

  it('shows the box only for a server answer', async () => {
    for (const reply of [
      undefined,
      { id: 1, ok: true, result: status(false) } as Reply,
      { id: 1, ok: false, error: 'unknown command' } as Reply,
      { id: 1, ok: true, result: null } as Reply
    ]) {
      const d = deps(reply)
      expect(await runSecondLaunch(d.deps)).toBe('none')
      expect(d.boxes).toEqual([])
      expect(d.asked).toEqual(['web.status'])
    }
    const d = deps({ id: 1, ok: true, result: status(true) })
    expect(await runSecondLaunch(d.deps)).toBe('cancel')
    expect(d.boxes).toEqual([serverBoxMessage('https://box.lan:7000')])
    // Cancel sends nothing more.
    expect(d.asked).toEqual(['web.status'])
  })

  it('Stop sends web.stop', async () => {
    const d = deps({ id: 1, ok: true, result: status(true) }, { box: () => Promise.resolve('stop') })
    expect(await runSecondLaunch(d.deps)).toBe('stop')
    expect(d.asked).toEqual(['web.status', 'web.stop'])
  })

  it('a test answer replaces the box; a failing box is Cancel', async () => {
    const t = deps({ id: 1, ok: true, result: status(true) }, { testAnswer: 'stop' })
    expect(await runSecondLaunch(t.deps)).toBe('stop')
    expect(t.boxes).toEqual([])
    expect(t.asked).toEqual(['web.status', 'web.stop'])
    const f = deps({ id: 1, ok: true, result: status(true) }, { box: () => Promise.reject(new Error('no screen')) })
    expect(await runSecondLaunch(f.deps)).toBe('cancel')
    expect(f.asked).toEqual(['web.status'])
  })

  it('a stop with no answer is logged', async () => {
    const d = deps({ id: 1, ok: true, result: status(true) }, { testAnswer: 'stop' })
    d.deps.ask = (cmd) => Promise.resolve(cmd === 'web.status' ? ({ id: 1, ok: true, result: status(true) } as Reply) : undefined)
    await runSecondLaunch(d.deps)
    expect(d.logs).toHaveLength(1)
  })
})

describe('socketAsk', () => {
  let dir: string
  let server: Server | undefined
  let peers: Socket[] = []
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-2nd-'))
  })
  afterEach(async () => {
    // Half-open peers keep the server from closing: end them first.
    for (const sock of peers) sock.destroy()
    peers = []
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
    server = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  function listen(onLine: (line: string, reply: (text: string) => void) => void): Promise<string> {
    const path = join(dir, 's.sock')
    // As main does: a client half-closes after its request (socket.end) and still gets its answer.
    server = createServer({ allowHalfOpen: true }, (sock) => {
      peers.push(sock)
      let buf = ''
      sock.on('data', (d) => {
        buf += d.toString()
        const nl = buf.indexOf('\n')
        if (nl >= 0) onLine(buf.slice(0, nl), (text) => sock.write(text))
      })
      sock.on('error', () => {})
    })
    return new Promise((resolve) => server!.listen(path, () => resolve(path)))
  }

  it('sends one tokenless, projectless request and returns the reply', async () => {
    const seen: string[] = []
    const path = await listen((line, reply) => {
      seen.push(line)
      reply(`${JSON.stringify({ id: 1, ok: true, result: { server: true } })}\n`)
    })
    const reply = await socketAsk(path, 'web.status', 1000)
    expect(reply).toEqual({ id: 1, ok: true, result: { server: true } })
    const request = parseRequest(seen[0]!)
    expect(request.cmd).toBe('web.status')
    expect(request.token).toBeUndefined()
    expect(request.project).toBeUndefined()
    expect(request.args).toEqual({})
  })

  it('gives up at the deadline when nobody answers', async () => {
    const path = await listen(() => {})
    const started = Date.now()
    expect(await socketAsk(path, 'web.status', 150)).toBeUndefined()
    const took = Date.now() - started
    expect(took).toBeGreaterThanOrEqual(140)
    expect(took).toBeLessThan(1500)
  })

  it('the deadline is 2 s', () => {
    expect(SECOND_LAUNCH_ASK_MS).toBe(2000)
  })

  it('no socket, or a garbled answer: undefined at once', async () => {
    expect(await socketAsk(join(dir, 'none.sock'), 'web.status', 5000)).toBeUndefined()
    const path = await listen((_line, reply) => reply('not json\n'))
    expect(await socketAsk(path, 'web.status', 5000)).toBeUndefined()
  })
})

describe('launchSocketPath', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-2nd-path-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('the data dir socket, as main computes it', () => {
    expect(launchSocketPath({ dataDir: '/d', env: {}, uid: 1000, tmpdir: dir })).toBe('/d/app.sock')
  })

  it('the fallback dir only when it is ours alone', () => {
    const uid = process.getuid?.()
    if (uid === undefined) return
    const long = `/${'x'.repeat(120)}`
    const fallback = fallbackSocketDir(dir, uid)
    expect(launchSocketPath({ dataDir: long, env: {}, uid, tmpdir: dir })).toBeUndefined()
    mkdirSync(fallback, { mode: 0o700 })
    expect(launchSocketPath({ dataDir: long, env: {}, uid, tmpdir: dir })?.startsWith(fallback)).toBe(true)
    chmodSync(fallback, 0o755)
    expect(launchSocketPath({ dataDir: long, env: {}, uid, tmpdir: dir })).toBeUndefined()
    chmodSync(fallback, 0o700)
    // Owned by someone else.
    expect(launchSocketPath({ dataDir: long, env: {}, uid: uid + 1, tmpdir: dir })).toBeUndefined()
  })
})

describe('privateLaunchProfile', () => {
  it('moves userData and sessionData to the new dir and removes it at exit', () => {
    const calls: string[] = []
    let exit: (() => void) | undefined
    const dir = privateLaunchProfile({
      makeDir: () => '/tmp/cc-cockpit-launch-1-abc',
      setPath: (name, path) => calls.push(`${name}=${path}`),
      onExit: (fn) => (exit = fn),
      remove: (d) => calls.push(`rm ${d}`)
    })
    expect(dir).toBe('/tmp/cc-cockpit-launch-1-abc')
    expect(calls).toEqual(['userData=/tmp/cc-cockpit-launch-1-abc', 'sessionData=/tmp/cc-cockpit-launch-1-abc'])
    exit?.()
    expect(calls.at(-1)).toBe('rm /tmp/cc-cockpit-launch-1-abc')
  })

  it('no dir: nothing is moved, the caller quits at once', () => {
    const calls: string[] = []
    const dir = privateLaunchProfile({
      makeDir: () => {
        throw new Error('ENOSPC')
      },
      setPath: (name) => calls.push(name),
      onExit: () => calls.push('exit'),
      remove: () => calls.push('rm')
    })
    expect(dir).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('a failing removal does not throw from the exit handler', () => {
    let exit: (() => void) | undefined
    privateLaunchProfile({
      makeDir: () => '/tmp/x',
      setPath: () => undefined,
      onExit: (fn) => (exit = fn),
      remove: () => {
        throw new Error('EBUSY')
      }
    })
    expect(() => exit?.()).not.toThrow()
  })
})

describe('sweepLaunchProfiles', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('removes the dirs of gone launches only, ours only, and nothing else in the temp dir', () => {
    const uid = process.getuid?.()
    for (const name of [
      `${LAUNCH_PROFILE_PREFIX}100-aaa`, // gone
      `${LAUNCH_PROFILE_PREFIX}200-bbb`, // alive: still showing its box
      `${LAUNCH_PROFILE_PREFIX}x-ccc`, // no pid
      `${LAUNCH_PROFILE_PREFIX}0100-ddd`, // not a pid as written
      'other-100-eee'
    ]) {
      mkdirSync(join(dir, name, 'Crashpad'), { recursive: true })
    }
    // A file with the prefix is not a profile.
    writeFileSync(join(dir, `${LAUNCH_PROFILE_PREFIX}101-fff`), '')
    sweepLaunchProfiles({ dir, uid, alive: (pid) => pid === 200 })
    expect(readdirSync(dir).sort()).toEqual(
      [
        `${LAUNCH_PROFILE_PREFIX}0100-ddd`,
        `${LAUNCH_PROFILE_PREFIX}101-fff`,
        `${LAUNCH_PROFILE_PREFIX}200-bbb`,
        `${LAUNCH_PROFILE_PREFIX}x-ccc`,
        'other-100-eee'
      ].sort()
    )
  })

  it("leaves another uid's dir, and a missing dir does not throw", () => {
    const uid = process.getuid?.()
    if (uid === undefined) return
    mkdirSync(join(dir, `${LAUNCH_PROFILE_PREFIX}100-aaa`))
    sweepLaunchProfiles({ dir, uid: uid + 1, alive: () => false })
    expect(readdirSync(dir)).toEqual([`${LAUNCH_PROFILE_PREFIX}100-aaa`])
    expect(() => sweepLaunchProfiles({ dir: join(dir, 'missing'), uid, alive: () => false })).not.toThrow()
  })

  it('pidAlive: this process lives, a pid past the max does not', () => {
    expect(pidAlive(process.pid)).toBe(true)
    expect(pidAlive(2 ** 30)).toBe(false)
  })
})
