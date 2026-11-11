// Server mode's start, end to end (design-web.md §9.1, §9.13): the built app with no display and no
// switches, which only this script tests. The re-exec replaces the image Playwright launched and drops
// its inspector connection, so the e2e harness starts the app with the switches directly instead.
//
//   node scripts/server-mode-smoke.mjs [executable]
//
// Without an argument it runs the built app in `out/` (npm run build first) under this repo's
// Electron, as a test run (CC_COCKPIT_TEST=1 and an empty CC_COCKPIT_MARKETPLACE_URLS, so it makes no
// request: the variable is read in a test run only). With an executable (a packaged cc-cockpit) it
// runs that, which ignores both, makes one background fetch of the default index and must pass offline.
//
// Each run: a temp data dir and HOME, no display, no session bus (a dead DBUS_SESSION_BUS_ADDRESS and a
// temp XDG_RUNTIME_DIR: unsetting the address alone is not enough on a systemd desktop, libdbus then
// finds $XDG_RUNTIME_DIR/bus), app.json pre-written (web access on, a random loopback port, mode None,
// the update check off). It waits for <data>/app.sock, checks the pid it started is still the app's
// (the exec runs), gets `GET /` 200 from the gateway, sends SIGTERM to that first pid only, checks the
// exit status, and after exit counts the live processes of the run (its session: the app is started
// as a session leader; zombies not counted): none. Runs: `--server` (stdout a pipe, web access stored
// off in desktop-confirm mode: start writes it on in link mode, says so, prints the address and no
// `#t=` link); no flag at all (detected, None); CC_COCKPIT_NO_EXECVE=1 (the fallback's spawnSync child
// and parent watch, `out/` only); `--server` under a pty (node-pty), link mode: the one-time `#t=` line
// appears, and a `POST /auth/link` with it answers 200 once and 401 the second time (design-web.md §9.3).
// Exits 1 on any failure.
import { spawn } from 'node:child_process'
import pty from 'node-pty'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packaged = process.argv[2]
const START_MS = 60_000
const QUIT_MS = 15_000

if (process.platform !== 'linux') {
  console.log('server mode runs on Linux only: nothing to test here')
  process.exit(0)
}

const command = packaged
  ? { exe: resolve(packaged), args: [] }
  : { exe: createRequire(import.meta.url)('electron'), args: [root] }
if (!packaged && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js is missing: run `npm run build` first')
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until(what, ms, check) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

/**
 * The pids of every live (not zombie) process of session `sid`. The app is started as a session
 * leader (`detached`), and every process of the run, the re-executed image, zygotes, renderers,
 * plugin hosts and ptys' children aside, stays in it even when reparented. Not the environment:
 * Chromium's process titles overwrite /proc/<pid>/environ.
 */
function processesOf(sid) {
  const pids = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      // The fields after the parenthesised command, which may hold spaces: state ppid pgrp session.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (fields[0] !== 'Z' && Number(fields[3]) === sid) pids.push(Number(name))
    } catch {
      // Gone meanwhile.
    }
  }
  return pids
}

/** The command line as one string: Chromium rewrites the process title into argv's memory, spaces and all. */
function cmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch {
    return ''
  }
}

/**
 * Starts the app as a session leader: a child process with stdout a pipe, or under a pty (node-pty
 * makes its child a session leader too). The same shape either way: pid, the output so far, exit.
 */
function launch(exe, args, env, underPty) {
  const proc = { pid: 0, out: '', exit: undefined, exited: undefined }
  if (underPty) {
    const term = pty.spawn(exe, args, { env, cols: 200, rows: 50, cwd: env.HOME })
    proc.pid = term.pid
    term.onData((d) => (proc.out += d))
    proc.exited = new Promise((r) =>
      term.onExit(({ exitCode, signal }) => {
        // node-pty gives a signal as its number (0 for none); `os.constants` names it.
        proc.exit = { code: signal ? null : exitCode, signal: signal ? signalName(signal) : null }
        r(proc.exit)
      })
    )
    return proc
  }
  const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.pid = child.pid
  child.stdout.on('data', (d) => (proc.out += d))
  child.stderr.on('data', () => {})
  proc.exited = new Promise((r) =>
    child.on('exit', (code, signal) => {
      proc.exit = { code, signal }
      r(proc.exit)
    })
  )
  return proc
}

function signalName(n) {
  for (const [name, value] of Object.entries(osConstants.signals)) if (value === n) return name
  return String(n)
}

/** A `POST /auth/link` as the sign-in page sends it (Origin-checked, JSON). */
async function signInWithLink(port, token) {
  const origin = `http://127.0.0.1:${port}`
  const res = await fetch(`${origin}/auth/link`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, name: 'smoke' })
  })
  return res.status
}

async function run(name, { flag, noExecve, underPty = false, webAccess }) {
  const base = mkdtempSync(join(tmpdir(), 'ccc-server-smoke-'))
  const dataDir = join(base, 'data')
  const home = join(base, 'home')
  const runtime = join(base, 'run')
  mkdirSync(dataDir, { mode: 0o700 })
  mkdirSync(home)
  mkdirSync(runtime, { mode: 0o700 })
  const port = 20000 + Math.floor(Math.random() * 20000)
  writeFileSync(
    join(dataDir, 'app.json'),
    JSON.stringify({
      schemaVersion: 1,
      openProjects: [],
      recentProjects: [],
      keyOverrides: {},
      pluginSettings: {},
      updateCheck: false,
      webAccess: { bind: '127.0.0.1', port, hosts: [], ...webAccess } })
  )
  const bus = 'unix:path=/nonexistent/bus'
  // Built from nothing, so no DISPLAY, WAYLAND_DISPLAY, CC_COCKPIT_SOCK, APP_TAB_*, CLAUDE_CODE_* or
  // ELECTRON_* of the shell running this script reaches the app.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    CC_COCKPIT_DATA_DIR: dataDir,
    DBUS_SESSION_BUS_ADDRESS: bus,
    XDG_RUNTIME_DIR: runtime
  }
  if (!packaged) {
    env.CC_COCKPIT_TEST = '1'
    env.CC_COCKPIT_MARKETPLACE_URLS = ''
  }
  if (noExecve) env.CC_COCKPIT_NO_EXECVE = '1'
  const args = [...command.args, ...(flag ? ['--server'] : [])]
  console.log(`\n== ${name}: ${[command.exe, ...args].join(' ')}${underPty ? ' (under a pty)' : ''}`)
  console.log(`   DBUS_SESSION_BUS_ADDRESS=${bus} XDG_RUNTIME_DIR=${runtime}`)

  const started = Date.now()
  const child = launch(command.exe, args, env, underPty)
  const sid = child.pid
  const exited = child.exited
  const failures = []
  try {
    await until('the CLI socket', START_MS, () => child.exit === undefined && existsSync(join(dataDir, 'app.sock')))
    console.log(`   socket after ${Date.now() - started} ms`)
    const argv = cmdline(child.pid)
    if (noExecve) {
      // The first process waits in spawnSync; the app is its child, carrying the parent marker.
      const app = processesOf(sid).find((pid) => cmdline(pid).includes(`--server-parent=${child.pid}`))
      if (!app) failures.push('no process carries the parent marker')
    } else if (!argv.includes('--ozone-platform=headless')) {
      failures.push(`pid ${child.pid} is not the re-executed app: ${argv}`)
    }
    const status = await until('the gateway', START_MS, async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/`)).status
      } catch {
        return 0
      }
    })
    if (status !== 200) failures.push(`GET / answered ${status}`)
    // The first lines (design-web.md §9.2, §9.3): the wrapper's path comes last, after the gateway.
    await until('the first lines', START_MS, () => child.out.includes('ccc for a shell on this server:'))
    const out = child.out
    if (!out.includes(`web access on http://127.0.0.1:${port}`)) failures.push('stdout has no address line')
    if (webAccess.enabled === false && !out.includes('server mode: turned web access on in app.json')) {
      failures.push('no "turned web access on" line for a stored off')
    }
    const at = out.indexOf('#t=')
    if (!underPty) {
      if (at >= 0) failures.push('a #t= link reached a pipe')
    } else if (at < 0) {
      failures.push('no #t= line under a pty')
    } else {
      let token = ''
      for (const ch of out.slice(at + 3)) {
        if (!/[A-Za-z0-9_-]/.test(ch)) break
        token += ch
      }
      const first = await signInWithLink(port, token)
      const second = await signInWithLink(port, token)
      console.log(`   start link: POST /auth/link ${first}, again ${second}`)
      if (first !== 200 || second !== 401) failures.push(`start link answered ${first} then ${second} (expected 200, 401)`)
    }
    const termAt = Date.now()
    process.kill(child.pid, 'SIGTERM')
    const result = await Promise.race([exited, sleep(QUIT_MS).then(() => undefined)])
    if (!result) failures.push(`still running ${QUIT_MS} ms after SIGTERM`)
    else {
      console.log(`   quit ${Date.now() - termAt} ms after SIGTERM: code ${result.code}, signal ${result.signal}`)
      // The fallback's first process is blocked in spawnSync before `ready`, with no handler of its
      // own: SIGTERM kills it, and the parent watch then quits its child.
      const expected = noExecve ? result.signal === 'SIGTERM' : result.code === 0
      if (!expected) failures.push(`exit status ${result.code} (signal ${result.signal})`)
    }
    const left = await until('the run to end', 5000, () => {
      const pids = processesOf(sid)
      return pids.length === 0 ? [] : undefined
    }).catch(() => processesOf(sid))
    if (left.length > 0) failures.push(`live processes left: ${left.join(' ')}`)
    // After the quit: app.json is saved debounced, and flushed at quit.
    if (webAccess.enabled === false) {
      const written = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')).webAccess
      if (written.enabled !== true || written.mode !== 'link') failures.push(`app.json not written on: ${JSON.stringify(written)}`)
    }
  } catch (err) {
    failures.push(err.message)
  } finally {
    for (const pid of processesOf(sid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(base, { recursive: true, force: true })
  }
  // The start link is used up (or was never made) by now; shown all the same only in its masked form.
  for (const line of child.out.split('\n').filter((l) => l.trim() !== '')) {
    console.log(`   stdout: ${line.trimEnd().replace(/#t=[A-Za-z0-9_-]+/, '#t=…')}`)
  }
  if (failures.length > 0) for (const f of failures) console.log(`   FAIL: ${f}`)
  else console.log('   ok')
  return failures.length === 0
}

const none = { enabled: true, mode: 'none' }
const results = [
  await run('--server', { flag: true, webAccess: { enabled: false, mode: 'confirm' } }),
  await run('detected (no flag)', { flag: false, webAccess: none })
]
if (!packaged) results.push(await run('fallback (CC_COCKPIT_NO_EXECVE=1)', { flag: true, noExecve: true, webAccess: none }))
results.push(await run('--server under a pty, link mode', { flag: true, underPty: true, webAccess: { enabled: true, mode: 'link' } }))
process.exit(results.every(Boolean) ? 0 : 1)
