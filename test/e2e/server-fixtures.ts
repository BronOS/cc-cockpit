// Server-mode e2e harness (design-web.md §9, plan 20261111-server-mode Task 2): the built app as a
// server with no display, driven from the plain browser of web-fixtures.ts.
//
// `launchServer` starts the app with server mode's switches directly (`--server
// --ozone-platform=headless --disable-gpu --password-store=basic`), which is what the re-exec starts:
// the re-exec itself replaces the image Playwright launched and drops its inspector connection, so
// only scripts/server-mode-smoke.mjs tests the detection and the re-exec. With the headless switch
// already on argv the decision does not re-exec (server-mode.ts), and with no `--server-parent`
// marker the parent watch is never armed.
//
// The app's env is launchCockpit's (fixtures.ts) less a display: DISPLAY and WAYLAND_DISPLAY are
// removed from the app's env only (the browser fixture keeps its display, it is a desktop browser),
// and no session bus: a dead DBUS_SESSION_BUS_ADDRESS and a temp XDG_RUNTIME_DIR (unsetting the
// address alone is not enough on a systemd desktop: libdbus then finds $XDG_RUNTIME_DIR/bus).
//
// Sign-in: `app.json` is pre-written with web access on, a random loopback port and mode None by
// default, as the smoke script does, so any browser on this machine is in with no link: the specs
// that do not test sign-in use it. A spec that does passes `mode: 'link'` (or 'password') and signs
// in the way a person on the server does, through `ccc web add-device` / `ccc web password` run
// from the data dir's wrapper (`ccc`, below).
//
// Linux only: server mode refuses to start anywhere else. Specs call `test.skip` on other platforms.
//
// Plan-time check (Task 2, 2026-11-11): Playwright's `_electron.launch` attaches to the Ozone
// headless process, `firstWindow()` resolves to the hidden page (the project shell, `.tabs-pane`)
// and the hooks on `__ccTest` answer (`serverMode()` is true), so server specs may use `cockpit.hook`.
import { expect } from '@playwright/test'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import { SECOND_LAUNCH_ANSWER_ENV } from '../../src/main/second-launch'
import { launchCockpit, type Cockpit, type LaunchOptions } from './fixtures'

/** The switches the re-exec appends (server-mode.ts), with `--server` in front. */
export const SERVER_SWITCHES = ['--server', '--ozone-platform=headless', '--disable-gpu', '--password-store=basic']

export interface ServerOptions extends Pick<LaunchOptions, 'env' | 'root'> {
  /** The sign-in mode written to a fresh `app.json`. Default 'none' (any browser on this machine is in). */
  mode?: 'none' | 'link' | 'password'
  /**
   * The gateway's port. Default: a random one (a taken one is retried). Pass it with `root` to start
   * again on the data dir of an earlier run, whose `app.json` already holds it.
   */
  port?: number
  /**
   * Keep CC_COCKPIT_FAKE_SECRETS=1 (the default, as every launch). False removes it from the app's
   * env, so the real server-mode store runs: the key file (server-secrets.spec.ts).
   */
  fakeSecrets?: boolean
}

export interface Server {
  /** The app as launchCockpit returns it: `page` is the hidden page, `hook` reaches main. */
  cockpit: Cockpit
  /** The pid of the app's main process (the one Playwright launched). */
  pid: number
  port: number
  /** `http://127.0.0.1:<port>`: the gateway's origin. */
  origin: string
  /** The id of the project the hidden page has open (the folder on argv). */
  projectId: string
  close(options?: { keepFiles?: boolean }): Promise<void>
}

/**
 * Starts the app as a server on a fresh data dir with the project folder on argv, web access on in
 * mode None on a random loopback port. A port that is taken (the gateway's state `failed`) is tried
 * again with another in a fresh launch, so a busy port on the machine cannot fail the spec.
 */
export async function launchServer(options: ServerOptions = {}): Promise<Server> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = options.port ?? 20000 + Math.floor(Math.random() * 20000)
    // mkdtemp makes it 0700, as an XDG_RUNTIME_DIR must be.
    const runtime = mkdtempSync(join(tmpdir(), 'ccc-e2e-run-'))
    const { cockpit, close } = await launchCockpit({
      args: SERVER_SWITCHES,
      ...(options.root !== undefined ? { root: options.root } : {}),
      settings: {
        updateCheck: false,
        webAccess: { enabled: true, bind: '127.0.0.1', port, mode: options.mode ?? 'none', hosts: [] }
      },
      env: {
        ...(options.fakeSecrets === false ? { CC_COCKPIT_FAKE_SECRETS: undefined } : {}),
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus',
        XDG_RUNTIME_DIR: runtime,
        ...options.env
      }
    })
    const closeAll = async (opts?: { keepFiles?: boolean }): Promise<void> => {
      await close(opts)
      rmSync(runtime, { recursive: true, force: true })
    }
    try {
      let state = ''
      await expect
        .poll(async () => {
          state = await cockpit.page.evaluate(async () => {
            const view = await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('settings.webAccess')
            return view.gateway.state
          })
          return state === 'listening' || state === 'failed' || state === 'refused'
        })
        .toBe(true)
      if (state === 'failed') {
        await closeAll(options.root !== undefined ? { keepFiles: true } : undefined)
        // A port the caller named is not ours to change.
        if (options.port !== undefined) throw new Error(`the gateway cannot listen on port ${options.port}`)
        continue
      }
      expect(state).toBe('listening')
      const projectId = await cockpit.page.evaluate(async () => {
        const info = await (window as unknown as { cockpit: CockpitApi }).cockpit.invoke('window.info')
        return info.kind === 'project' ? info.project.id : ''
      })
      expect(projectId).not.toBe('')
      const pid = cockpit.app.process().pid
      if (pid === undefined) throw new Error('the server has no pid')
      return { cockpit, pid, port, origin: `http://127.0.0.1:${port}`, projectId, close: closeAll }
    } catch (err) {
      await closeAll()
      throw err
    }
  }
  throw new Error('the server never listened: five random ports were taken')
}

/** True while `pid` is a live process (signal 0 checks without sending anything). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Main is alive: its pid lives and the gateway answers `GET /` with 200. Every server spec calls it
 * at its end: the spike's faults (a crash in a dialog or a desktop-only call) killed main while the
 * page the spec was looking at still showed its last frame.
 */
export async function expectMainAlive(server: Server): Promise<void> {
  expect(alive(server.pid), `main (pid ${server.pid}) is not running`).toBe(true)
  const res = await fetch(`${server.origin}/`)
  expect(res.status).toBe(200)
  await res.body?.cancel()
}

export interface CccResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * `ccc` as a person on the server runs it: the data dir's own wrapper (`<data>/bin/ccc`, written at
 * start) from a shell with no tab in its env, which is the only caller `ccc web` serves. The env is
 * built from nothing (no CC_COCKPIT_SOCK, APP_TAB_*, CLAUDE_CODE_* of the shell running the suite);
 * the wrapper names the data dir itself. `input` is stdin (a password), then closed. Bounded: the
 * CLI's own deadlines are 40 s.
 */
export function ccc(server: Server, args: string[], input?: string): Promise<CccResult> {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(server.cockpit.root, 'home'), LANG: 'C.UTF-8' }
  return new Promise((resolve) => {
    const child = execFile(
      join(server.cockpit.dataDir, 'bin', 'ccc'),
      args,
      { env, timeout: 45_000 },
      (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })
      }
    )
    // A ccc that exits before reading stdin (a password refused early) gives EPIPE; the spec must see its stderr, not crash.
    child.stdin?.on('error', () => {})
    child.stdin?.end(input ?? '')
  })
}

/** The one link `ccc web add-device` prints on stdout (what it is goes to stderr). */
export async function addDeviceLink(server: Server): Promise<string> {
  const res = await ccc(server, ['web', 'add-device'])
  const link = res.stdout.trim()
  expect(res.code, `ccc web add-device failed: ${res.stderr}`).toBe(0)
  expect(link.startsWith(`${server.origin}/#t=`), `unexpected link ${link}`).toBe(true)
  return link
}

/**
 * A second launch of the app on this machine's desktop (`cc-cockpit <folder>` typed while `holder`
 * holds the data dir): a desktop Electron process with the suite's display, the holder's data dir,
 * a test run, so `answer` answers the box it shows when the holder is a server (second-launch.ts).
 * Resolves with its exit; bounded by the spec's timeout.
 */
export function secondLaunch(
  holder: Cockpit,
  folder: string,
  answer: 'stop' | 'cancel'
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const repo = resolve(__dirname, '../..')
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // As launchCockpit: nothing that changes what Electron is, and never the suite's own cockpit tab.
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('ELECTRON_')) continue
    if (k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k === 'CLAUDE_CONFIG_DIR') continue
    env[k] = v
  }
  Object.assign(env, {
    CC_COCKPIT_DATA_DIR: holder.dataDir,
    CC_COCKPIT_TEST: '1',
    [SECOND_LAUNCH_ANSWER_ENV]: answer,
    HOME: join(holder.root, 'home')
  })
  // The electron package's main export, in Node, is the binary's path.
  const electronPath = createRequire(__filename)('electron') as string
  const child = spawn(electronPath, [join(repo, 'out/main/index.js'), folder], { cwd: repo, env, stdio: 'ignore' })
  return new Promise((done) => child.once('exit', (code, signal) => done({ code, signal })))
}
