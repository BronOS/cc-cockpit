#!/usr/bin/env node
// Stand-in for OpenSSH's `ssh` in the remote-desktop e2e (test/e2e/remote-desktop.spec.ts, plan
// 20261112-remote-desktop Task 8). The spec puts a one-line `ssh` wrapper for this script first on
// the desktop app's PATH (the app's login env keeps PATH, createSshSpawn finds `ssh` there), so the
// app's real argv for `ssh` reaches this file. It parses argv like OpenSSH does and refuses (exit
// 255, like ssh) an argv missing what the app must always pass: BatchMode=yes, ControlMaster=no,
// ControlPath=none, RemoteCommand=none, ClearAllForwardings=yes and `--` before the host.
//
// Configuration, all through the env (nothing of the real machine is touched):
//   FAKE_SSH_CCC        absolute path of the test server's data-dir `ccc` wrapper
//   FAKE_SSH_HOME       a temp dir used as the "remote" HOME; `.config/cc-cockpit/bin/ccc` is made in it as a
//                       symlink to FAKE_SSH_CCC, which is where the app's remote script looks
//   FAKE_SSH_BAD_HOSTS  comma-separated hosts whose login fails: `Permission denied (publickey).`, exit 255
//   FAKE_SSH_LOG        append-only log: `command <host>` and `tunnel <L> <P> pid=<pid>` lines
//
// Modes: with a remote command, it runs that string through `sh -c` (what the remote's login shell
// does with ssh's command line). With `-N -L`, it listens on 127.0.0.1:L, logs the debug line the
// app waits for, relays TCP to 127.0.0.1:P and stays up until killed.
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const die = (message, code = 255) => {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}
const log = (line) => {
  if (process.env.FAKE_SSH_LOG) appendFileSync(process.env.FAKE_SSH_LOG, `${line}\n`)
}

const options = new Map()
let forward
let noCommand = false
let sawDashDash = false
let host
const rest = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (sawDashDash) {
    if (host === undefined) host = a
    else rest.push(a)
  } else if (a === '--') {
    sawDashDash = true
  } else if (a === '-o') {
    const kv = argv[++i] ?? ''
    const eq = kv.indexOf('=')
    options.set(kv.slice(0, eq), kv.slice(eq + 1))
  } else if (a === '-L') {
    forward = argv[++i]
  } else if (a === '-N') {
    noCommand = true
  } else if (a === '-T' || a === '-v') {
    // no argument
  } else {
    die(`fake-ssh: unexpected option ${a}`)
  }
}
if (!sawDashDash) die('fake-ssh: the argv has no `--` before the host')
if (host === undefined) die('fake-ssh: no host')
for (const [key, value] of [
  ['BatchMode', 'yes'],
  ['ControlMaster', 'no'],
  ['ControlPath', 'none'],
  ['RemoteCommand', 'none'],
  ['ClearAllForwardings', 'yes']
]) {
  if (options.get(key) !== value) die(`fake-ssh: -o ${key}=${value} is missing`)
}

if ((process.env.FAKE_SSH_BAD_HOSTS ?? '').split(',').includes(host)) {
  die(`${host}: Permission denied (publickey).`)
}

if (noCommand) {
  const m = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(forward ?? '')
  if (m === null) die(`fake-ssh: bad -L spec ${String(forward)}`)
  const local = Number(m[1])
  const remote = Number(m[2])
  const server = createServer((client) => {
    const upstream = connect({ host: '127.0.0.1', port: remote })
    client.pipe(upstream)
    upstream.pipe(client)
    const drop = () => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', drop)
    upstream.on('error', drop)
    client.on('close', drop)
    upstream.on('close', drop)
  })
  server.once('error', () => {
    process.stderr.write(`bind [127.0.0.1]:${local}: Address already in use\n`)
    process.stderr.write(`channel_setup_fwd_listener_tcpip: cannot listen to port: ${local}\n`)
    process.exit(255)
  })
  server.listen({ host: '127.0.0.1', port: local, exclusive: true }, () => {
    log(`tunnel ${local} ${remote} pid=${process.pid}`)
    process.stderr.write(`debug1: Local forwarding listening on 127.0.0.1 port ${local}.\n`)
  })
  // ssh -N exits on a signal; the default action of SIGTERM does it, and the listener dies with it.
} else {
  log(`command ${host} ${rest.join(' ')}`)
  if (rest.length !== 1) die(`fake-ssh: expected one remote command string, got ${rest.length}`)
  const home = process.env.FAKE_SSH_HOME
  const ccc = process.env.FAKE_SSH_CCC
  if (home === undefined || ccc === undefined) die('fake-ssh: FAKE_SSH_HOME and FAKE_SSH_CCC are not set')
  const link = join(home, '.config', 'cc-cockpit', 'bin', 'ccc')
  if (!existsSync(link)) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(ccc, link)
  }
  // The remote login shell reads the one string ssh sends; sh does here. Only HOME and PATH are set:
  // nothing of the real home, and no tab's env, reaches the server's CLI.
  const child = spawn('/bin/sh', ['-c', rest[0]], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' }
  })
  child.on('exit', (code, signal) => process.exit(code ?? (signal !== null ? 255 : 0)))
}
