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
// Sign-in: `app.json` is pre-written with web access on, a random loopback port and mode None, as
// the smoke script does (server mode does not turn web access on by itself yet, and `ccc web
// add-device` does not exist yet), so any browser on this machine is in with no link.
//
// Linux only: server mode refuses to start anywhere else. Specs call `test.skip` on other platforms.
//
// Plan-time check (Task 2, 2026-11-11): Playwright's `_electron.launch` attaches to the Ozone
// headless process, `firstWindow()` resolves to the hidden page (the project shell, `.tabs-pane`)
// and the hooks on `__ccTest` answer (`serverMode()` is true), so server specs may use `cockpit.hook`.
import { expect } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CockpitApi } from '../../src/shared/ipc'
import { launchCockpit, type Cockpit, type LaunchOptions } from './fixtures'

/** The switches the re-exec appends (server-mode.ts), with `--server` in front. */
export const SERVER_SWITCHES = ['--server', '--ozone-platform=headless', '--disable-gpu', '--password-store=basic']

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
export async function launchServer(options: Pick<LaunchOptions, 'env'> = {}): Promise<Server> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    // mkdtemp makes it 0700, as an XDG_RUNTIME_DIR must be.
    const runtime = mkdtempSync(join(tmpdir(), 'ccc-e2e-run-'))
    const { cockpit, close } = await launchCockpit({
      args: SERVER_SWITCHES,
      settings: {
        updateCheck: false,
        webAccess: { enabled: true, bind: '127.0.0.1', port, mode: 'none', hosts: [] }
      },
      env: {
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
        await closeAll()
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
