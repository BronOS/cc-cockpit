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
// One more run with the port already taken (design-web.md §9.1 "Start order"): the app exits with status
// 1 on its own, and no renderer process (a window, the picker's included) ever appeared in the run.
// `ccc web` (§9.4): every run asks `<data>/bin/ccc web status --json` (server mode, listening on its
// port) and checks a tab's token is refused with the host-only text; one run ends with `ccc web stop`
// instead of SIGTERM, which must quit the same way (status 0, nothing left). The `--server` run (link
// mode once start wrote it) also signs in through `ccc web add-device` (§9.4): the printed link's
// `POST /auth/link` answers 200 once and 401 the second time, and a tab's token gets no link.
// One `--server` run opens a project folder (on argv) and shows web views off-screen
// (design-web-browser.md §3.1, §2): `ccc --project <dir> browser open` of a local page exits 0 with
// `ok` (a navigate the CLI waits on loads at once, with no browser showing the panel), then pages
// that call alert/confirm/prompt, print(), and click a file input and the File System Access
// pickers (without a user gesture: the trusted-input cases need the browsers' input, a later task),
// each followed by `ccc browser url` showing the title the page set after the call returned; a
// refused port is a load error (exit 1). Main must answer `ccc web status` after each, and quit as
// every run does (status 0, nothing left), off-screen pages and all.
//
// On macOS (plan 20261119-server-mode-mac, decision 10; design-web.md §9.15) only `--server` starts a
// server, with no re-exec, so the pid that printed the first lines is the app: its argv has no Ozone
// switch, LaunchServices lists it as `UIElement` (no Dock icon) and `pmset -g assertions` shows its
// idle-sleep hold. Processes are read with `ps` (no /proc): the run is the started pid's process group
// (a session leader's pgid is its pid), plus every descendant seen before the stop, so a helper or a
// pty's child that left the group still counts. The detected run and the fallback are Linux-only and
// skipped with a line. The `--server` run also starts a second `--server` on the same data dir, which
// must exit 1 with the held line while the first keeps serving. The reopen case (`out/` only): `--server`
// from a copy of Electron.app with its own CFBundleIdentifier (LaunchServices routes by bundle, and other
// runs on the Mac use the stock one), then `open -a <copy>`: no second process starts, and the reopen
// notice answers from CC_COCKPIT_TEST_SERVER_BOX: `stop` exits the server with 0, `cancel` leaves it
// serving and back to `UIElement`. The copy lives under /private/tmp/claude-<uid>/ (else the temp dir) and is
// unregistered from LaunchServices and removed at the end. Not here: a real LaunchAgent (`launchctl`, the
// person's login session), which the owner runs by hand (plan 20261119-server-mode-mac, O1).
// Exits 1 on any failure.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
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

const darwin = process.platform === 'darwin'
if (process.platform !== 'linux' && !darwin) {
  console.log('server mode runs on Linux and macOS only: nothing to test here')
  process.exit(0)
}
/** server-mode.ts `HELD_LINE`: a darwin `--server` that lost the data dir's lock. */
const HELD_LINE = 'server mode: not started: cc-cockpit already runs with this data dir (the desktop app or another server)'

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
  if (darwin) return psTable().filter((p) => p.pgid === sid).map((p) => p.pid)
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
  if (darwin) return psTable().find((p) => p.pid === pid)?.command ?? ''
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch {
    return ''
  }
}

/**
 * macOS (no /proc): every live process as `ps -A -o pid=,ppid=,pgid=,stat=,command=` reads it, zombies
 * (a `stat` starting with Z) left out. `command` last: it may hold spaces.
 */
function psTable() {
  let out
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return []
  }
  const rows = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line)
    if (!m || m[4].startsWith('Z')) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), stat: m[4], command: m[5] })
  }
  return rows
}

/** macOS: `pid` and every live descendant by parent pid (helpers, plugin hosts, ptys and their children). */
function descendantsOf(pid) {
  const rows = psTable()
  const found = new Set([pid])
  for (let grew = true; grew; ) {
    grew = false
    for (const row of rows) {
      if (found.has(row.ppid) && !found.has(row.pid)) {
        found.add(row.pid)
        grew = true
      }
    }
  }
  return [...found].filter((p) => rows.some((row) => row.pid === p))
}

/** macOS: which of `pids` are still alive (not zombies). */
function aliveOf(pids) {
  const live = new Set(psTable().map((p) => p.pid))
  return pids.filter((p) => live.has(p))
}

/** macOS: the LaunchServices type of `pid` (`UIElement`, `Foreground` ...), or `not listed`. */
function lsType(pid) {
  return /type="([^"]+)"/.exec(lsBlock(pid))?.[1] ?? 'not listed'
}

function lsBlock(pid) {
  let out
  try {
    out = execFileSync('lsappinfo', ['list'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    return ''
  }
  return out.split(/\n(?=\s*\d+\) ")/).find((b) => b.includes(`pid = ${pid} `)) ?? ''
}

/** macOS: the `pmset -g assertions` lines `pid` holds (`pid <n>(<name>): ...`). */
function assertionsOf(pid) {
  try {
    return execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' })
      .split('\n')
      .filter((l) => l.includes(`pid ${pid}(`))
      .map((l) => l.trim())
  } catch {
    return []
  }
}

/**
 * macOS: the app is the pid that was started (no re-exec, no Ozone switch), Dock-less (`UIElement`) and
 * holding idle sleep off for the run (server-platform.ts; Chromium's `prevent-app-suspension` shows as
 * `NoIdleSleepAssertion`, the per-pid name of the `PreventUserIdleSystemSleep` kind).
 */
async function checkDarwinApp(pid, failures) {
  const argv = cmdline(pid)
  if (argv === '' || argv.includes('--ozone-platform') || argv.includes('--server-parent=')) {
    failures.push(`pid ${pid} is not the app as started: ${argv}`)
  }
  const type = await until('a LaunchServices entry', 10_000, () => {
    const t = lsType(pid)
    return t === 'not listed' ? undefined : t
  }).catch(() => 'not listed')
  const held = assertionsOf(pid)
  const sleepHold = held.find((l) => l.includes('NoIdleSleepAssertion') || l.includes('PreventUserIdleSystemSleep'))
  console.log(`   pid ${pid}: LaunchServices type ${type}; ${sleepHold ?? 'no idle-sleep assertion'}`)
  if (type !== 'UIElement') failures.push(`LaunchServices type ${type}, expected UIElement:\n${lsBlock(pid)}`)
  if (!sleepHold) failures.push(`no idle-sleep assertion for pid ${pid}: ${JSON.stringify(held)}`)
}

/**
 * macOS: a second `--server` on the same data dir while the first serves (decision 2, `refuseWhenHeld`):
 * it exits 1 by itself with the held line on stdout, leaves nothing behind, and the first keeps serving.
 */
async function checkHeld(args, env, port, dataDir, failures) {
  const second = launch(command.exe, args, env, false)
  const result = await Promise.race([second.exited, sleep(START_MS).then(() => undefined)])
  if (!result) failures.push(`the second --server still runs ${START_MS} ms after start`)
  else {
    console.log(`   second --server: code ${result.code}, signal ${result.signal}, stdout ${JSON.stringify(second.out.trim())}`)
    if (result.code !== 1) failures.push(`the second --server exited with ${result.code} (signal ${result.signal}), expected 1`)
    if (!second.out.includes(HELD_LINE)) failures.push(`the second --server did not print the held line: ${JSON.stringify(second.out)}`)
  }
  const left = await until('the second run to end', 5000, () => (processesOf(second.pid).length === 0 ? [] : undefined)).catch(() =>
    processesOf(second.pid)
  )
  if (left.length > 0) failures.push(`the second --server left processes: ${left.join(' ')}`)
  const status = await fetch(`http://127.0.0.1:${port}/`).then(
    (res) => res.status,
    () => 0
  )
  if (status !== 200) failures.push(`after the second --server, GET / answered ${status}`)
  const web = await ccc(dataDir, env, ['web', 'status', '--json'])
  if (web.code !== 0) failures.push(`after the second --server, ccc web status: exit ${web.code}: ${web.stderr.trim()}`)
}

/** second-launch.ts `SECOND_LAUNCH_ANSWER_ENV`: a test run's answer to the box, no box shown. */
const SECOND_LAUNCH_ANSWER_ENV = 'CC_COCKPIT_TEST_SERVER_BOX'
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

/**
 * macOS: a clone of this repo's Electron.app with its own bundle id, ad-hoc signed again (the Info.plist
 * edit breaks the seal), so `open -a` can reach only this run (§9.15 S3). Returns its paths and a cleanup.
 */
function copyBundle() {
  const stock = resolve(dirname(command.exe), '..', '..')
  const parent = existsSync(`/private/tmp/claude-${process.getuid()}`) ? `/private/tmp/claude-${process.getuid()}` : tmpdir()
  const dir = mkdtempSync(join(parent, 'ccc-smoke-bundle-'))
  const bundle = join(dir, 'Electron.app')
  execFileSync('cp', ['-c', '-R', stock, bundle])
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', `dev.cc-cockpit.smoke.${process.pid}`, join(bundle, 'Contents', 'Info.plist')])
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' })
  return {
    bundle,
    exe: join(bundle, 'Contents', 'MacOS', 'Electron'),
    remove: () => {
      try {
        execFileSync(LSREGISTER, ['-u', bundle], { stdio: 'ignore' })
      } catch {
        // never registered
      }
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** macOS: live main processes of the copied bundle (its helpers carry `--type=`). */
function bundleMains(exe) {
  return psTable()
    .filter((p) => (p.command === exe || p.command.startsWith(`${exe} `)) && !p.command.includes('--type='))
    .map((p) => p.pid)
}

/**
 * macOS, the reopen case: `--server` from the copy, `open -a` the copy, the notice answered by `answer`.
 * `stop`: the server exits 0 on its own. `cancel`: it keeps serving and is `UIElement` again (the routed
 * launch makes it `Foreground`; the notice puts the accessory policy back). Either way no second process.
 */
async function runReopen(copy, answer) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const { base, dataDir, env } = newRunEnv(port, { enabled: true, mode: 'none' })
  env[SECOND_LAUNCH_ANSWER_ENV] = answer
  const args = [root, '--server']
  console.log(`\n== reopen (open -a on a bundle copy), notice answered ${answer}: ${[copy.exe, ...args].join(' ')}`)
  const child = launch(copy.exe, args, env, false)
  const sid = child.pid
  const failures = []
  let seen = []
  let others = new Set()
  try {
    await until('the gateway', START_MS, async () =>
      child.exit === undefined && existsSync(join(dataDir, 'app.sock'))
        ? await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status === 200, () => false)
        : false
    )
    await checkDarwinApp(child.pid, failures)
    seen = [...new Set([...descendantsOf(child.pid), ...processesOf(sid)])]
    execFileSync('open', ['-a', copy.bundle])
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (answer === 'cancel' || child.exit === undefined)) {
      for (const pid of bundleMains(copy.exe)) if (pid !== child.pid) others.add(pid)
      if (answer === 'cancel' && Date.now() > deadline - 5000 && lsType(child.pid) === 'UIElement') break
      await sleep(100)
    }
    if (answer === 'stop') {
      const result = await Promise.race([child.exited, sleep(QUIT_MS).then(() => undefined)])
      console.log(`   after open -a: ${result ? `exited, code ${result.code}, signal ${result.signal}` : 'still running'}`)
      if (!result || result.code !== 0) failures.push(`the notice's Stop: ${result ? `code ${result.code}, signal ${result.signal}` : 'still running'}`)
    } else {
      const type = lsType(child.pid)
      const status = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status, () => 0)
      console.log(`   after open -a: type ${type}, GET / ${status}`)
      if (child.exit !== undefined) failures.push(`the server exited after a Cancel: ${JSON.stringify(child.exit)}`)
      if (type !== 'UIElement') failures.push(`LaunchServices type ${type} after the notice, expected UIElement`)
      if (status !== 200) failures.push(`GET / answered ${status} after the notice`)
      await checkWebStatus(dataDir, env, port, failures)
      seen = [...new Set([...seen, ...descendantsOf(child.pid)])]
      process.kill(child.pid, 'SIGTERM')
      const result = await Promise.race([child.exited, sleep(QUIT_MS).then(() => undefined)])
      if (!result || result.code !== 0) failures.push(`SIGTERM: ${result ? `code ${result.code}, signal ${result.signal}` : 'still running'}`)
    }
    for (const pid of bundleMains(copy.exe)) if (pid !== child.pid) others.add(pid)
    if (others.size > 0) failures.push(`open -a started another process: ${[...others].join(' ')}`)
    const left = await until('the run to end', 5000, () => {
      const pids = [...processesOf(sid), ...aliveOf(seen)]
      return pids.length === 0 ? [] : undefined
    }).catch(() => [...processesOf(sid), ...aliveOf(seen)])
    console.log(`   ${seen.length} processes seen in the run, ${left.length} left`)
    if (left.length > 0) failures.push(`live processes left: ${left.join(' ')}`)
  } catch (err) {
    failures.push(err.message)
  } finally {
    for (const pid of [...processesOf(sid), ...aliveOf(seen), ...bundleMains(copy.exe)]) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    rmSync(base, { recursive: true, force: true })
  }
  for (const line of child.out.split('\n').filter((l) => l.trim() !== '')) console.log(`   stdout: ${line.trimEnd()}`)
  if (failures.length > 0) for (const f of failures) console.log(`   FAIL: ${f}`)
  else console.log('   ok')
  return failures.length === 0
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

/** The data dir's `ccc` wrapper (written at start) with `args`: its exit code and output, bounded. */
function ccc(dataDir, env, args) {
  return new Promise((r) => {
    execFile(join(dataDir, 'bin', 'ccc'), args, { env, timeout: 20_000 }, (err, stdout, stderr) => {
      r({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })
    })
  })
}

/** `ccc web status --json` from a shell (no token): server mode, on, listening on `port`; a tab token refused. */
async function checkWebStatus(dataDir, env, port, failures) {
  const status = await ccc(dataDir, env, ['web', 'status', '--json'])
  let parsed
  try {
    parsed = JSON.parse(status.stdout)
  } catch {
    parsed = undefined
  }
  console.log(`   ccc web status --json: exit ${status.code}, gateway ${JSON.stringify(parsed?.gateway)}`)
  if (status.code !== 0 || !parsed) failures.push(`ccc web status --json: exit ${status.code}: ${status.stderr.trim()}`)
  else if (parsed.server !== true || parsed.enabled !== true || parsed.gateway?.state !== 'listening' || parsed.gateway?.port !== port) {
    failures.push(`ccc web status --json: unexpected ${status.stdout.trim()}`)
  } else if (status.stdout.includes('#t=')) failures.push('ccc web status printed a link')
  // A tab's token (any, a forged one too) is refused before anything is looked up.
  const fromTab = await ccc(dataDir, { ...env, APP_TAB_TOKEN: 'f'.repeat(64), CC_COCKPIT_SOCK: join(dataDir, 'app.sock') }, ['web', 'status'])
  if (fromTab.code !== 1 || !fromTab.stderr.includes('run `ccc web` from a shell on the server')) {
    failures.push(`ccc web status with a tab token: exit ${fromTab.code}: ${fromTab.stderr.trim()}`)
  }
}

/** The token of a `…/#t=<token>` link: the base64url characters after the marker. */
function tokenAfter(text, at) {
  let token = ''
  for (const ch of text.slice(at + 3)) {
    if (!/[A-Za-z0-9_-]/.test(ch)) break
    token += ch
  }
  return token
}

/**
 * `ccc web add-device` from a shell: one link on stdout, which signs in once (200, then 401). From a
 * tab (any token) it is refused with the host-only text and prints no link.
 */
async function checkAddDevice(dataDir, env, port, failures) {
  const fromTab = await ccc(dataDir, { ...env, APP_TAB_TOKEN: 'f'.repeat(64), CC_COCKPIT_SOCK: join(dataDir, 'app.sock') }, ['web', 'add-device'])
  if (fromTab.code !== 1 || fromTab.stdout.includes('#t=') || !fromTab.stderr.includes('run `ccc web` from a shell on the server')) {
    failures.push(`ccc web add-device with a tab token: exit ${fromTab.code}: ${fromTab.stderr.trim()}`)
  }
  const added = await ccc(dataDir, env, ['web', 'add-device'])
  const at = added.stdout.indexOf('#t=')
  if (added.code !== 0 || at < 0) {
    failures.push(`ccc web add-device: exit ${added.code}: ${added.stderr.trim()}`)
    return
  }
  const token = tokenAfter(added.stdout, at)
  const first = await signInWithLink(port, token)
  const second = await signInWithLink(port, token)
  console.log(`   ccc web add-device: POST /auth/link ${first}, again ${second}`)
  if (first !== 200 || second !== 401) failures.push(`ccc web add-device link answered ${first} then ${second} (expected 200, 401)`)
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

/** The pages of the web view step: each sets its title once the calls it makes have returned. */
const WEBVIEW_PAGES = {
  'page.html': ['<!doctype html><title>Smoke page</title><p>off-screen</p>', 'Smoke page'],
  'dialogs.html': [
    '<!doctype html><title>dialogs</title><script>alert("a"); confirm("c"); try { prompt("p") } catch {} document.title = "after dialogs"</script>',
    'after dialogs'
  ],
  'print.html': ['<!doctype html><title>print</title><script>window.print(); document.title = "after print"</script>', 'after print'],
  'pickers.html': [
    '<!doctype html><title>pickers</title><input type="file" id="f"><script>' +
      'document.getElementById("f").click();' +
      'Promise.allSettled([window.showOpenFilePicker?.(), window.showSaveFilePicker?.(), window.showDirectoryPicker?.()])' +
      '.then(() => { document.title = "after pickers" })</script>',
    'after pickers'
  ]
}

/**
 * The web view step (see the top): every page through `ccc browser open`, its title through `ccc
 * browser url`, a refused port, and `ccc web status` after each. The first open retries while the
 * project window and the browser plugin come up.
 */
async function checkWebviews(dataDir, env, projectDir, failures) {
  const browser = (args) => ccc(dataDir, env, ['--project', projectDir, 'browser', ...args])
  const alive = async (after) => {
    const status = await ccc(dataDir, env, ['web', 'status', '--json'])
    if (status.code !== 0) failures.push(`ccc web status after ${after}: exit ${status.code}: ${status.stderr.trim()}`)
  }
  let first
  const deadline = Date.now() + START_MS
  for (;;) {
    first = await browser(['open', join(projectDir, 'page.html')])
    if (first.code === 0 || Date.now() > deadline) break
    await sleep(500)
  }
  for (const [name, [, title]] of Object.entries(WEBVIEW_PAGES)) {
    const open = name === 'page.html' ? first : await browser(['open', join(projectDir, name)])
    if (open.code !== 0 || open.stdout !== 'ok\n') {
      failures.push(`ccc browser open ${name}: exit ${open.code}: ${open.stdout}${open.stderr.trim()}`)
      continue
    }
    // The title the page set after its calls returned (a load resolves before a slow script ends).
    let url
    for (let i = 0; i < 50; i++) {
      url = await browser(['url'])
      if (url.stdout.endsWith(`\t${title}\n`)) break
      await sleep(100)
    }
    console.log(`   ccc browser open ${name}: ok, url ${JSON.stringify(url.stdout.trim())}`)
    if (url.code !== 0 || !url.stdout.startsWith('cc-preview://') || !url.stdout.endsWith(`\t${title}\n`)) {
      failures.push(`ccc browser url after ${name}: exit ${url.code}: ${url.stdout}${url.stderr.trim()}`)
    }
    await alive(name)
  }
  const refused = await browser(['open', 'http://127.0.0.1:9/'])
  console.log(`   ccc browser open http://127.0.0.1:9/: exit ${refused.code}: ${refused.stderr.trim()}`)
  if (refused.code !== 1 || !refused.stderr.includes('did not load')) {
    failures.push(`ccc browser open of a refused port: exit ${refused.code}: ${refused.stdout}${refused.stderr.trim()}`)
  }
  await alive('a refused port')
}

/** A TCP listener on a random loopback port, so the app's gateway finds it taken. */
async function takePort() {
  const blocker = createServer(() => {})
  await new Promise((r, j) => blocker.once('error', j).listen(0, '127.0.0.1', r))
  return { port: blocker.address().port, close: () => new Promise((r) => blocker.close(r)) }
}

/**
 * The port is taken: the run must end by itself with status 1, and no renderer (a project window or
 * the picker) may have started first. Processes are polled until the exit; a renderer lives as long
 * as its window, far longer than one poll.
 */
async function runPortTaken() {
  const taken = await takePort()
  const env = newRunEnv(taken.port, { enabled: true, mode: 'none' })
  const args = [...command.args, '--server']
  console.log(`\n== --server, port ${taken.port} already taken: ${[command.exe, ...args].join(' ')}`)
  const child = launch(command.exe, args, env.env, false)
  const sid = child.pid
  const failures = []
  let renderer = false
  try {
    const result = await Promise.race([
      child.exited,
      (async () => {
        const deadline = Date.now() + START_MS
        while (child.exit === undefined && Date.now() < deadline) {
          if (darwin) {
            // One `ps` per poll, and slower: forking it every 20 ms would load a Mac other runs share.
            if (psTable().some((p) => p.pgid === sid && p.command.includes('--type=renderer'))) renderer = true
            await sleep(100)
            continue
          }
          if (processesOf(sid).some((pid) => cmdline(pid).includes('--type=renderer'))) renderer = true
          await sleep(20)
        }
        return child.exit
      })()
    ])
    if (!result) failures.push(`still running ${START_MS} ms after start with the port taken`)
    else {
      console.log(`   exited: code ${result.code}, signal ${result.signal}`)
      if (result.code !== 1) failures.push(`exit status ${result.code} (signal ${result.signal}), expected 1`)
    }
    if (renderer) failures.push('a renderer (a window) started before the exit')
    if (existsSync(join(env.dataDir, 'app.sock'))) failures.push('app.sock left behind')
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
    await taken.close()
    rmSync(env.base, { recursive: true, force: true })
  }
  for (const line of child.out.split('\n').filter((l) => l.trim() !== '')) console.log(`   stdout: ${line.trimEnd()}`)
  if (failures.length > 0) for (const f of failures) console.log(`   FAIL: ${f}`)
  else console.log('   ok')
  return failures.length === 0
}

/** A temp data dir, HOME and runtime dir with app.json pre-written, and the env built from nothing. */
function newRunEnv(port, webAccess) {
  const base = mkdtempSync(join(tmpdir(), 'ccc-server-smoke-'))
  const dataDir = join(base, 'data')
  const home = join(base, 'home')
  const runtime = join(base, 'run')
  mkdirSync(dataDir, { mode: 0o700 })
  mkdirSync(home)
  mkdirSync(runtime, { mode: 0o700 })
  writeFileSync(
    join(dataDir, 'app.json'),
    JSON.stringify({
      schemaVersion: 1,
      openProjects: [],
      recentProjects: [],
      keyOverrides: {},
      pluginSettings: {},
      updateCheck: false,
      // macOS: a project opened (the web view step) starts no Claude tab, the person's `claude` included.
      ...(darwin ? { claudeTabOnOpen: false } : {}),
      webAccess: { bind: '127.0.0.1', port, hosts: [], ...webAccess } })
  )
  const bus = 'unix:path=/nonexistent/bus'
  // Built from nothing, so no DISPLAY, WAYLAND_DISPLAY, CC_COCKPIT_SOCK, APP_TAB_*, CLAUDE_CODE_* or
  // ELECTRON_* of the shell running this script reaches the app.
  const env = darwin
    ? {
        // No session bus or runtime dir on macOS; the fake `claude` first, should a tab start one.
        PATH: [join(root, 'test', 'fixtures', 'bin'), process.env.PATH ?? '/usr/bin:/bin'].join(':'),
        HOME: home,
        LANG: 'en_US.UTF-8',
        CC_COCKPIT_DATA_DIR: dataDir
      }
    : {
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
  return { base, dataDir, runtime, bus, env }
}

async function run(name, { flag, noExecve, underPty = false, webAccess, stopWithCcc = false, addDevice = false, webviews = false, held = false }) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const { base, dataDir, runtime, bus, env } = newRunEnv(port, webAccess)
  if (noExecve) env.CC_COCKPIT_NO_EXECVE = '1'
  // The web view step's project: a folder of its own under HOME (a file directly in HOME is refused).
  const projectDir = join(env.HOME, 'proj')
  if (webviews) {
    mkdirSync(projectDir)
    for (const [file, [html]] of Object.entries(WEBVIEW_PAGES)) writeFileSync(join(projectDir, file), html)
  }
  const args = [...command.args, ...(flag ? ['--server'] : []), ...(webviews ? [projectDir] : [])]
  console.log(`\n== ${name}: ${[command.exe, ...args].join(' ')}${underPty ? ' (under a pty)' : ''}`)
  if (!darwin) console.log(`   DBUS_SESSION_BUS_ADDRESS=${bus} XDG_RUNTIME_DIR=${runtime}`)

  const started = Date.now()
  const child = launch(command.exe, args, env, underPty)
  const sid = child.pid
  const exited = child.exited
  const failures = []
  // macOS: every descendant seen while the run serves, checked gone after the stop.
  let seen = []
  try {
    await until('the CLI socket', START_MS, () => child.exit === undefined && existsSync(join(dataDir, 'app.sock')))
    console.log(`   socket after ${Date.now() - started} ms`)
    const argv = cmdline(child.pid)
    if (darwin) {
      await checkDarwinApp(child.pid, failures)
    } else if (noExecve) {
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
      const token = tokenAfter(out, at)
      const first = await signInWithLink(port, token)
      const second = await signInWithLink(port, token)
      console.log(`   start link: POST /auth/link ${first}, again ${second}`)
      if (first !== 200 || second !== 401) failures.push(`start link answered ${first} then ${second} (expected 200, 401)`)
    }
    await checkWebStatus(dataDir, env, port, failures)
    if (addDevice) await checkAddDevice(dataDir, env, port, failures)
    if (webviews) await checkWebviews(dataDir, env, projectDir, failures)
    if (held) await checkHeld(args, env, port, dataDir, failures)
    if (darwin) seen = [...new Set([...descendantsOf(child.pid), ...processesOf(sid)])]
    const termAt = Date.now()
    const how = stopWithCcc ? 'ccc web stop' : 'SIGTERM'
    if (stopWithCcc) {
      const stop = await ccc(dataDir, env, ['web', 'stop'])
      if (stop.code !== 0 || stop.stdout !== 'cc-cockpit is stopping\n') failures.push(`ccc web stop: exit ${stop.code}: ${stop.stdout}${stop.stderr}`)
    } else {
      process.kill(child.pid, 'SIGTERM')
    }
    const result = await Promise.race([exited, sleep(QUIT_MS).then(() => undefined)])
    if (!result) failures.push(`still running ${QUIT_MS} ms after ${how}`)
    else {
      console.log(`   quit ${Date.now() - termAt} ms after ${how}: code ${result.code}, signal ${result.signal}`)
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
    if (darwin) {
      const stray = aliveOf(seen)
      console.log(`   ${seen.length} processes seen in the run, ${stray.length} left`)
      if (stray.length > 0) {
        const rows = psTable().filter((p) => stray.includes(p.pid))
        failures.push(`processes of the run left (out of its group or not): ${rows.map((p) => `${p.pid} ${p.command}`).join('; ')}`)
      }
    }
    // After the quit: app.json is saved debounced, and flushed at quit.
    if (webAccess.enabled === false) {
      const written = JSON.parse(readFileSync(join(dataDir, 'app.json'), 'utf8')).webAccess
      if (written.enabled !== true || written.mode !== 'link') failures.push(`app.json not written on: ${JSON.stringify(written)}`)
    }
  } catch (err) {
    failures.push(err.message)
  } finally {
    for (const pid of [...processesOf(sid), ...(darwin ? aliveOf(seen) : [])]) {
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
const results = [await run('--server', { flag: true, webAccess: { enabled: false, mode: 'confirm' }, addDevice: true, held: darwin })]
if (darwin) {
  console.log('\n== detected (no flag): skipped on macOS (only --server starts a server there; a Mac always has a display)')
  console.log('== fallback (CC_COCKPIT_NO_EXECVE=1): skipped on macOS (no re-exec there, so no fallback)')
} else results.push(await run('detected (no flag)', { flag: false, webAccess: none }))
if (!packaged && !darwin) results.push(await run('fallback (CC_COCKPIT_NO_EXECVE=1)', { flag: true, noExecve: true, webAccess: none }))
results.push(await run('--server under a pty, link mode', { flag: true, underPty: true, webAccess: { enabled: true, mode: 'link' } }))
results.push(await run('--server, stopped with ccc web stop', { flag: true, webAccess: none, stopWithCcc: true }))
results.push(await run('--server with web views off-screen', { flag: true, webAccess: none, webviews: true }))
results.push(await runPortTaken())
if (darwin && packaged) {
  console.log('\n== reopen (open -a): skipped for a packaged app (it ignores the test answer, so a real box would show; O1 by hand)')
} else if (darwin) {
  const copy = copyBundle()
  try {
    results.push(await runReopen(copy, 'cancel'))
    results.push(await runReopen(copy, 'stop'))
  } finally {
    copy.remove()
  }
}
process.exit(results.every(Boolean) ? 0 : 1)
