// SPIKE (T0, plan 20261119-server-mode-mac S3; reusable by T7): does `open -a <bundle>` route to a running
// `--server` run of that bundle, starting no process? Starts out/ as a darwin server from <bundle> (a copy of
// Electron.app with its own CFBundleIdentifier, so LaunchServices cannot route to another Electron run on this
// Mac), on a temp data dir in a test run, then runs `open -a <bundle>` and compares the bundle's main processes,
// the pid's LaunchServices type, its pmset assertion and the `activate` lines main prints (`activateLine`, a
// substring; the spike's main prints "SPIKE activate"). Usage:
//   node scripts/spike/open-routes.mjs <path/to/Copy.app> [activateLine]
// Needs a build of out/ where darwin `--server` starts (T1, or the T0 gate); master's server refuses on darwin.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const bundle = resolve(process.argv[2] ?? '')
const activateLine = process.argv[3] ?? 'SPIKE activate'
const exe = join(bundle, 'Contents/MacOS', basename(bundle) === 'Electron.app' ? 'Electron' : readFileSync(join(bundle, 'Contents/Info.plist'), 'utf8').match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)</)[1])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }) } catch (e) { return 'ERR ' + String(e).slice(0, 200) } }

/** Live processes running the bundle's main executable (helpers excluded), by ps, as T7's smoke counts them. */
function mains() {
  return sh('ps', ['-A', '-o', 'pid=,comm=']).split('\n').map((l) => l.trim()).filter((l) => l.endsWith(exe)).map((l) => Number(l.split(/\s+/)[0]))
}
function lsType(pid) {
  const block = sh('lsappinfo', ['list']).split(/\n(?=\s*\d+\) ")/).find((b) => b.includes(`pid = ${pid} `)) ?? ''
  if (process.env.SPIKE_VERBOSE) console.error('lsappinfo ' + block)
  return /type="([^"]+)"/.exec(block)?.[1] ?? 'not listed'
}
const assertion = (pid) => sh('pmset', ['-g', 'assertions']).split('\n').filter((l) => l.includes(`pid ${pid}(`)).join(' | ').trim()

const root = realpathSync(mkdtempSync(join(tmpdir(), 'spike-s3-')))
const [dataDir, homeDir, projectDir] = ['data', 'home', 'project'].map((d) => join(root, d))
const probe = join(root, 'probe')
for (const d of [dataDir, homeDir, projectDir, probe]) mkdirSync(d)
const port = 20000 + Math.floor(Math.random() * 20000)
writeFileSync(join(dataDir, 'app.json'), JSON.stringify({ schemaVersion: 1, claudeTabOnOpen: false, updateCheck: false, webAccess: { enabled: true, bind: '127.0.0.1', port, mode: 'none', hosts: [] } }))
// The harness's env scrub (test/e2e/fixtures.ts): nothing that aims the run at the person's app or Claude.
const env = {}
for (const [k, v] of Object.entries(process.env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('ELECTRON_') || k.startsWith('CC_COCKPIT_') || k.startsWith('APP_TAB_') || k === 'CLAUDE_CONFIG_DIR') continue
  env[k] = v
}
Object.assign(env, { CC_COCKPIT_DATA_DIR: dataDir, CC_COCKPIT_TEST: '1', CC_COCKPIT_FAKE_SECRETS: '1', CC_COCKPIT_NO_BUNDLED: '1', CC_COCKPIT_MARKETPLACE_URLS: '', HOME: homeDir,
  // The spike build's probe (window visibility after the routed launch); a build without it ignores the variable.
  SPIKE_PROBE_DIR: probe,
  SHELL: join(REPO, 'test/fixtures/bin/fake-shell'), PATH: [join(REPO, 'test/fixtures/bin'), env.PATH ?? ''].join(delimiter) })
const logPath = join(root, 'server.log')
const before = mains()
const child = spawn(exe, [join(REPO, 'out/main/index.js'), '--server', '--use-mock-keychain', projectDir], { cwd: REPO, env, stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')] })
const activates = () => readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes(activateLine)).length
const report = {}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/`)).status === 200) break } catch { /* not up yet */ } ; await sleep(500) }
  await sleep(5000) // settle
  report.start = { pid: child.pid, mains: mains().filter((p) => !before.includes(p)), type: lsType(child.pid), assertion: assertion(child.pid), activates: activates() }
  writeFileSync(join(probe, 'dump'), ''); await sleep(2500)
  try { const d = JSON.parse(readFileSync(join(probe, 'dump-0.json'), 'utf8')); report.start.windows = { windows: d.windows, dock: d.dock } } catch { report.start.windows = 'no probe' }
  const t = Date.now()
  report.open = sh('open', ['-a', bundle]).trim() || 'ok'
  await sleep(5000)
  writeFileSync(join(probe, 'dump'), ''); await sleep(2500)
  try { const d = JSON.parse(readFileSync(join(probe, 'dump-1.json'), 'utf8')); report.windowsAfterOpen = { windows: d.windows, dock: d.dock, type: lsType(child.pid) } } catch { report.windowsAfterOpen = 'no probe' }
  report.afterOpen = { ms: Date.now() - t, mains: mains().filter((p) => !before.includes(p)), activates: activates(), alive: child.exitCode === null }
  sh('open', ['-a', bundle]); await sleep(3000)
  report.afterSecondOpen = { mains: mains().filter((p) => !before.includes(p)), activates: activates() }
  // Does a routed launch leave the run a Dock app (LaunchServices type Foreground)? Read again later.
  await sleep(Number(process.env.SPIKE_LATER_MS ?? 30000))
  report.later = { type: lsType(child.pid) }
} finally {
  child.kill('SIGTERM')
  for (let i = 0; i < 20 && child.exitCode === null; i++) await sleep(250)
  report.exit = { code: child.exitCode, signal: child.signalCode, left: mains().filter((p) => !before.includes(p)) }
  // A process `open` started (a routing failure) is ours to end.
  for (const pid of report.exit.left) { try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ } }
  report.log = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('SPIKE') || /rror/.test(l)).slice(-20)
  console.log(JSON.stringify(report, null, 1))
  rmSync(root, { recursive: true, force: true })
}
