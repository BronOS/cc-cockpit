// The real node-pty backend, which vitest cannot load directly: node-pty is built for the Electron
// ABI. The adapter is bundled with esbuild (node-pty left external) and run by Electron's own Node
// (ELECTRON_RUN_AS_NODE), so this exercises the shipped node-pty-backend.ts against a real PTY.
//
// What it pins: a child that exits while its PTY is paused for flow control still delivers its
// last output before the exit (exit-drain.ts). Without the drain, node-pty destroys the unread
// socket 200 ms after the exit and the output is lost (measured: nothing arrived at all).
// And app quit (PtyService.disposeAll, bundled with the backend): a child that ignores SIGHUP
// is SIGKILLed after the short grace instead of outliving the app (it did, with SIGHUP only).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'

const root = resolve(__dirname, '../..')
const electron = createRequire(__filename)('electron') as unknown as string
let dir: string

// The runner: spawn through the backend, pause before any output is read, report what arrived.
const RUNNER = `
const { NodePtyBackend } = require('./backend.js')
const pty = new NodePtyBackend().spawn(['/bin/sh', '-c', process.argv[2]], {
  cwd: process.cwd(), env: { PATH: process.env.PATH || '/usr/bin:/bin' }, cols: 80, rows: 24
})
let out = ''
pty.onData((d) => { out += d })
pty.onExit((code) => {
  process.stdout.write(JSON.stringify({ code, out }))
  process.exit(0)
})
pty.pause()
// Never resumed by the caller: only the backend's own drain can read the tail.
setTimeout(() => { process.stdout.write(JSON.stringify({ timeout: true, out })); process.exit(0) }, 5000)
`

// The quit runner: a child that traps HUP, disposeAll as at will-quit, then whether it is still
// running 2 s later. `alive` is asked of the backend handle (signal 0 to its pid); a survivor is
// killed here so a failing run leaves no `sleep` behind.
const QUIT_RUNNER = `
const { NodePtyBackend } = require('./backend.js')
const { PtyService } = require('./service.js')
let handle
const backend = { spawn: (argv, opts) => (handle = new NodePtyBackend().spawn(argv, opts)) }
let out = ''
const svc = new PtyService({ backend, sink: { data: (_id, d) => { out += d }, exit: () => {} } })
svc.spawn('t1', ['/bin/sh', '-c', 'trap "" HUP; echo READY; exec sleep 30'], {
  cwd: process.cwd(), env: { PATH: process.env.PATH || '/usr/bin:/bin' }, cols: 80, rows: 24
})
const started = Date.now()
const poll = setInterval(() => {
  if (!out.includes('READY') && Date.now() - started < 5000) return
  clearInterval(poll)
  const t = Date.now()
  svc.disposeAll(200)
  const waitedMs = Date.now() - t
  // SIGKILL is delivered and the child reaped asynchronously: give it a moment to be gone.
  const until = Date.now() + 2000
  const check = setInterval(() => {
    const alive = handle.alive()
    if (alive && Date.now() < until) return
    clearInterval(check)
    if (alive) handle.kill('SIGKILL')
    process.stdout.write(JSON.stringify({ ready: out.includes('READY'), alive, waitedMs }))
    process.exit(0)
  }, 10)
}, 10)
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-node-pty-'))
  for (const [entry, outfile] of [
    ['src/main/pty/node-pty-backend.ts', 'backend.js'],
    ['src/main/pty/pty-service.ts', 'service.js']
  ] as const) {
    buildSync({
      entryPoints: [join(root, entry)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['node-pty'],
      outfile: join(dir, outfile),
      logLevel: 'silent'
    })
  }
  writeFileSync(join(dir, 'runner.js'), RUNNER)
  writeFileSync(join(dir, 'quit-runner.js'), QUIT_RUNNER)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(command: string, runner = 'runner.js'): { code?: number; out: string; timeout?: boolean } {
  const result = spawnSync(electron, [join(dir, runner), command], {
    cwd: dir,
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: join(root, 'node_modules'),
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: dir
    },
    encoding: 'utf8',
    timeout: 20_000
  })
  if (result.status !== 0) throw new Error(`runner failed: ${result.stderr || String(result.error)}`)
  return JSON.parse(result.stdout) as { code?: number; out: string; timeout?: boolean }
}

describe.skipIf(process.platform === 'win32')('NodePtyBackend (real node-pty)', () => {
  it('a child that exits while paused still delivers its tail before the exit', () => {
    const result = run('echo first; echo TAIL-MARKER; exit 3')
    expect(result.timeout).toBeUndefined()
    expect(result.code).toBe(3)
    expect(result.out).toContain('first')
    expect(result.out).toContain('TAIL-MARKER')
  }, 30_000)

  it('app quit SIGKILLs a child that ignores SIGHUP once the grace is over', () => {
    const result = run('', 'quit-runner.js') as unknown as { ready: boolean; alive: boolean; waitedMs: number }
    expect(result.ready).toBe(true)
    expect(result.alive).toBe(false)
    // It waited out the grace for the trapped HUP, and not much longer.
    expect(result.waitedMs).toBeGreaterThanOrEqual(150)
    expect(result.waitedMs).toBeLessThan(2000)
  }, 30_000)
})
