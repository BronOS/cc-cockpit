// ctx.processes runs REAL child processes (this Node): what matters is what the OS does with argv,
// bytes on the pipes and process-group kills, which a fake spawn would not show. Temp dirs only.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HostContexts } from '../../src/host/ctx'
import { spawnProcess, type ProcessesContext } from '../../src/host/ctx/processes'
import type { PluginProcess, ProcessExit } from '../../src/sdk/types'
import { hostSpec } from '../fakes/host-spec'

const node = process.execPath

/** Everything a process writes to stdout, and its exit. */
function collect(p: PluginProcess): Promise<{ out: Buffer; err: Buffer; exit: ProcessExit }> {
  const out: Buffer[] = []
  const err: Buffer[] = []
  p.onData((b) => out.push(Buffer.from(b)))
  p.onStderr((b) => err.push(Buffer.from(b)))
  return new Promise((resolve) => p.onExit((exit) => resolve({ out: Buffer.concat(out), err: Buffer.concat(err), exit })))
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('ctx.processes', () => {
  let root: string
  let ctx: ProcessesContext
  let reported: unknown[]
  const started: PluginProcess[] = []
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-proc-')))
    reported = []
    ctx = { projectDir: root, env: { PATH: process.env.PATH }, running: new Set(), report: (e) => reported.push(e) }
  })
  afterEach(() => {
    for (const p of started.splice(0)) p.kill()
    rmSync(root, { recursive: true, force: true })
  })
  const run = (argv: string[], c: ProcessesContext = ctx, cwd?: string): PluginProcess => {
    const p = spawnProcess(argv, cwd === undefined ? {} : { cwd }, c)
    started.push(p)
    return p
  }

  it('keeps argv items whole: spaces and shell characters stay one argument each', async () => {
    const nasty = ['a b  c', '$(touch pwned)', '; echo x', '"q" \'s\'', '*', '']
    const r = await collect(run([node, '-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...nasty]))
    expect(JSON.parse(r.out.toString('utf8'))).toEqual(nasty)
    expect(r.exit).toEqual({ code: 0, signal: null })
  })

  it('round-trips bytes on stdin and stdout, multi-byte and NUL included', async () => {
    const p = run([node, '-e', 'process.stdin.pipe(process.stdout)'])
    const done = collect(p)
    const bytes = Buffer.concat([Buffer.from('héllo\0'), Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.alloc(200_000, 7)])
    // Split inside a multi-byte character: bytes, not text, so nothing is re-encoded.
    p.write(bytes.subarray(0, 2))
    p.write(new Uint8Array(bytes.subarray(2)))
    p.end()
    const r = await done
    expect(r.out.equals(bytes)).toBe(true)
    expect(r.exit.code).toBe(0)
  })

  it('reports stderr apart from stdout, and the exit code after the last output', async () => {
    const order: string[] = []
    const p = run([node, '-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'])
    p.onData(() => order.push('data'))
    const r = await collect(p)
    order.push('exit')
    expect(r.out.toString()).toBe('out')
    expect(r.err.toString()).toBe('err')
    expect(r.exit).toEqual({ code: 3, signal: null })
    expect(order).toEqual(['data', 'exit'])
    // A late onExit is still told (soon, not inside the call); a late write is ignored.
    const late = await new Promise<ProcessExit>((resolve) => p.onExit(resolve))
    expect(late).toEqual({ code: 3, signal: null })
    expect(() => p.write(Buffer.from('x'))).not.toThrow()
  })

  it('kill() ends the whole process group with SIGKILL', async () => {
    // The child starts a grandchild (in the child's group, which the child leads) and prints its pid.
    const p = run([node, '-e', `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));setInterval(()=>{},1000)`])
    let grandchild = 0
    p.onData((b) => (grandchild = Number(Buffer.from(b).toString())))
    const exit = new Promise<ProcessExit>((resolve) => p.onExit(resolve))
    await until(() => grandchild > 0)
    p.kill()
    expect(await exit).toEqual({ code: null, signal: 'SIGKILL' })
    await until(() => !alive(grandchild))
  })

  it('caps running processes per plugin and frees a slot on exit', async () => {
    const small = { ...ctx, max: 2 }
    const a = run([node, '-e', 'setInterval(()=>{},1000)'], small)
    run([node, '-e', 'setInterval(()=>{},1000)'], small)
    expect(() => run([node, '-e', '0'], small)).toThrow('already runs 2 processes')
    const gone = new Promise((resolve) => a.onExit(resolve))
    a.kill()
    await gone
    expect(() => run([node, '-e', '0'], small)).not.toThrow()
  })

  it('throws for a program that cannot run, a bad cwd and bad argv; a relative cwd is the project folder', async () => {
    expect(() => run(['cc-no-such-program-xyz'])).toThrow('cannot run cc-no-such-program-xyz')
    expect(ctx.running.size).toBe(0)
    expect(() => run([node, '-e', '0'], ctx, 'missing')).toThrow('is not an existing directory')
    expect(() => run([])).toThrow('non-empty array')
    expect(() => run(['ls', 'a\0b'])).toThrow('NUL')
    expect(() => spawnProcess([node], { cwd: '' }, ctx)).toThrow('cwd')
    const r = await collect(run([node, '-e', 'process.stdout.write(process.cwd())']))
    expect(r.out.toString()).toBe(root)
  })

  it('takes only bytes on write; a listener that throws is reported, not fatal', async () => {
    const p = run([node, '-e', 'process.stdout.write("a")'])
    expect(() => p.write('text' as unknown as Uint8Array)).toThrow('Uint8Array')
    p.onData(() => {
      throw new Error('boom')
    })
    const r = await collect(p)
    expect(r.out.toString()).toBe('a')
    expect(String(reported[0])).toContain('boom')
  })

  it("drops Chromium's disabled: bus address", async () => {
    const env = { PATH: process.env.PATH, DBUS_SESSION_BUS_ADDRESS: 'disabled:' }
    const r = await collect(run([node, '-e', 'process.stdout.write(String(process.env.DBUS_SESSION_BUS_ADDRESS))'], { ...ctx, env }))
    expect(r.out.toString()).toBe('undefined')
  })

  // The leader exits at once; a grandchild of its group lives on (holding the pipes or not).
  const leaderLeaving = (hold: boolean): string[] => [
    node,
    '-e',
    `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${hold ? "['ignore','inherit','inherit']" : "'ignore'"}});process.stdout.write(String(c.pid));setTimeout(()=>process.exit(0),100)`
  ]

  it('kills the group of a leader that exited on its own, grandchild holding the pipes or not', async () => {
    for (const hold of [false, true]) {
      const p = run(leaderLeaving(hold))
      let grandchild = 0
      p.onData((b) => (grandchild = Number(Buffer.from(b).toString())))
      const exit = new Promise<ProcessExit>((resolve) => p.onExit(resolve))
      await until(() => grandchild > 0)
      // The group is killed at the leader's exit, so a grandchild holding the pipes lets them close
      // then; the slot is freed at onExit.
      expect((await exit).code).toBe(0)
      expect(ctx.running.size).toBe(0)
      await until(() => !alive(grandchild))
    }
  }, 15000)

  it('the group is killed at the leader\'s exit, before the close (a pgid freed by then could be reused)', async () => {
    const p = run(leaderLeaving(true))
    let grandchild = 0
    p.onData((b) => (grandchild = Number(Buffer.from(b).toString())))
    const exit = new Promise<ProcessExit>((resolve) => p.onExit(resolve))
    await until(() => grandchild > 0)
    const t = Date.now()
    await exit
    // Well inside the 2 s grace: the grandchild died with the leader's exit and its pipes closed.
    expect(Date.now() - t).toBeLessThan(1500)
    await until(() => !alive(grandchild))
  })

  it('a pipe held by a grandchild does not keep the exit back past the grace', async () => {
    const t = Date.now()
    const r = await collect(run(leaderLeaving(true)))
    expect(r.exit.code).toBe(0)
    expect(Date.now() - t).toBeLessThan(5000)
  })

  it('throws past 64 MiB pending on stdin (a fake stdin), ignores write after end()', () => {
    const written: unknown[] = []
    const stdin = Object.assign(new EventEmitter(), {
      writableLength: 64 * 1024 * 1024 - 1,
      destroyed: false,
      writable: true,
      write: (b: unknown) => written.push(b),
      end: () => {
        stdin.writable = false
      },
      destroy: () => {}
    })
    const fake = Object.assign(new EventEmitter(), { pid: 999999, stdin, stdout: new EventEmitter(), stderr: new EventEmitter() })
    const p = spawnProcess([node], {}, { ...ctx, spawnFn: () => fake as never })
    expect(() => p.write(new Uint8Array(1))).not.toThrow()
    expect(() => p.write(new Uint8Array(2))).toThrow(RangeError)
    p.end()
    p.write(new Uint8Array(1))
    expect(written).toHaveLength(1)
  })

  it('always reads: a child writing far more than a pipe buffer to stderr with no listener still exits', async () => {
    const p = run([node, '-e', 'process.stderr.write(Buffer.alloc(1024*1024,1));process.stdout.write(Buffer.alloc(1024*1024,1))'])
    const exit = await new Promise<ProcessExit>((resolve) => p.onExit(resolve))
    expect(exit).toEqual({ code: 0, signal: null })
  })

  it('a failed spawn (ENOENT on the next tick) is not an uncaught error, and a rejecting async listener is reported', async () => {
    let uncaught: unknown
    const onUncaught = (e: unknown): void => {
      uncaught = e
    }
    process.on('uncaughtException', onUncaught)
    try {
      const fake = Object.assign(new EventEmitter(), { pid: 999998, stdin: null, stdout: null, stderr: null })
      spawnProcess([node], {}, { ...ctx, spawnFn: () => fake as never })
      setTimeout(() => fake.emit('error', new Error('spawn ENOENT')), 0)
      await new Promise((r) => setTimeout(r, 30))
      expect(uncaught).toBeUndefined()
    } finally {
      process.off('uncaughtException', onUncaught)
    }
    const p = run([node, '-e', 'process.stdout.write("a")'])
    p.onData(async () => {
      throw new Error('async boom')
    })
    await collect(p)
    await until(() => reported.length > 0)
    expect(String(reported[0])).toContain('async boom')
  })

  it("does not call exit listeners after the plugin's dispose, and kills a group the leader left", async () => {
    const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH } })
    const c = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js' }))
    const p = c.processes.spawn([node, '-e', 'setInterval(()=>{},1000)'])
    let called = false
    p.onExit(() => (called = true))
    contexts.dispose('a.one')
    await until(() => !alive(p.pid))
    await new Promise((r) => setTimeout(r, 100))
    expect(called).toBe(false)
  })

  describe('through the plugin ctx', () => {
    const forever = [node, '-e', 'setInterval(()=>{},1000)']

    it('kills every process when the plugin is disposed (stop, reload), and spawns nothing after', async () => {
      const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH } })
      const c = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js' }))
      const p = c.processes.spawn(forever)
      contexts.dispose('a.one')
      await until(() => !alive(p.pid))
      expect(() => c.processes.spawn(forever)).toThrow('deactivated')
    })

    it('kills every process when the host stops (killChildrenAndFlush), the plugin stays usable', async () => {
      const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH } })
      const c = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js' }))
      const ps = [c.processes.spawn(forever), c.processes.spawn(forever)]
      const exits = ps.map((p) => new Promise<ProcessExit>((resolve) => p.onExit(resolve)))
      contexts.killChildrenAndFlush()
      for (const e of await Promise.all(exits)) expect(e.signal).toBe('SIGKILL')
      for (const p of ps) expect(alive(p.pid)).toBe(false)
      const again = c.processes.spawn([node, '-e', 'process.exit(5)'])
      expect((await collect(again)).exit.code).toBe(5)
      contexts.dispose('a.one')
    })

    it('counts the cap per plugin', () => {
      const contexts = new HostContexts({ log: () => {}, env: { PATH: process.env.PATH } })
      const a = contexts.create(hostSpec({ id: 'a.one', dir: root, main: 'm.js' }))
      const b = contexts.create(hostSpec({ id: 'b.two', dir: root, main: 'm.js' }))
      try {
        for (let i = 0; i < 16; i++) a.processes.spawn(forever)
        expect(() => a.processes.spawn(forever)).toThrow('already runs 16 processes')
        expect(() => b.processes.spawn(forever)).not.toThrow()
      } finally {
        contexts.disposeAll()
      }
    })
  })
})

