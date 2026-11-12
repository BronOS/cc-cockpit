#!/usr/bin/env node
// A small SSH server for the remote-desktop e2e (test/e2e/remote-desktop.spec.ts, plan
// 20261112-remote-ssh-builtin Task 7): the built-in `ssh2` client of the app (main/remote/ssh-client.ts)
// dials this one on a loopback port, as it would a real sshd. Nothing of the real machine is touched.
//
// Arguments (`--name value`):
//   --host-key FILE   the host key (an OpenSSH or PEM private key the spec wrote once; a restart on the
//                     same file keeps the key, another file is the "changed" case)       required
//   --port N          the loopback port; default random. The port is printed on stdout, one line, once
//                     the server listens
//   --user NAME       the one account that signs in                                        required
//   --password TEXT   accepted by `password` auth (none: password auth refused)
//   --pubkey FILE     an OpenSSH public key line accepted by `publickey` auth (none: refused)
//   --home DIR        the "remote" HOME a command runs with                               required
//   --ccc PATH        the test server's data-dir `ccc` wrapper; made the symlink
//                     `<home>/.config/cc-cockpit/bin/ccc`, where the app's REMOTE_SCRIPT looks (it sets
//                     `CCC` itself, so the env cannot name it)                             required
//   --log FILE        append-only log: `exec <command>` and `tcpip <port>` lines
//
// `exec` runs the command string with `sh -c` (what a sshd's login shell does with it) with only HOME,
// PATH and LANG in its env, so nothing of a tab or the real home reaches the server's CLI. `direct-tcpip`
// connects locally to 127.0.0.1 (anything else is refused). SIGTERM closes the server and every client.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import ssh2 from 'ssh2'

const { Server, utils } = ssh2

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])
const need = (name) => {
  const v = args.get(name)
  if (v === undefined) {
    process.stderr.write(`ssh-server: --${name} is required\n`)
    process.exit(2)
  }
  return v
}
const hostKey = readFileSync(need('host-key'))
const user = need('user')
const password = args.get('password')
const home = need('home')
const ccc = need('ccc')
const logFile = args.get('log')
const log = (line) => {
  if (logFile !== undefined) appendFileSync(logFile, `${line}\n`)
}
const allowed = args.has('pubkey') ? utils.parseKey(readFileSync(args.get('pubkey'))) : undefined

const link = join(home, '.config', 'cc-cockpit', 'bin', 'ccc')
if (!existsSync(link)) {
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(ccc, link)
}

const clients = new Set()
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  clients.add(client)
  client.on('error', () => {})
  client.on('close', () => clients.delete(client))
  client.on('authentication', (ctx) => {
    const methods = []
    if (password !== undefined) methods.push('password')
    if (allowed !== undefined && !(allowed instanceof Error)) methods.push('publickey')
    if (ctx.username !== user) return ctx.reject(methods)
    if (ctx.method === 'password' && password !== undefined) {
      return ctx.password === password ? ctx.accept() : ctx.reject(methods)
    }
    if (ctx.method === 'publickey' && methods.includes('publickey')) {
      if (ctx.key.algo !== allowed.type || !allowed.getPublicSSH().equals(ctx.key.data)) return ctx.reject(methods)
      // The first round asks whether the key would do; the second carries the signature.
      if (!ctx.signature || !ctx.blob) return ctx.accept()
      return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject(methods)
    }
    return ctx.reject(methods)
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        log(`exec ${info.command}`)
        const child = spawn('/bin/sh', ['-c', info.command], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' }
        })
        stream.pipe(child.stdin)
        child.stdin.on('error', () => {})
        child.stdout.pipe(stream, { end: false })
        child.stderr.pipe(stream.stderr, { end: false })
        child.on('close', (code, signal) => {
          stream.exit(code ?? (signal !== null ? 255 : 0))
          stream.end()
        })
        stream.on('close', () => child.kill())
      })
    })
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1') return reject()
      log(`tcpip ${info.destPort}`)
      // As sshd does: the channel opens only once the connect succeeded.
      const sock = connect(info.destPort, '127.0.0.1')
      sock.once('error', () => reject())
      sock.once('connect', () => {
        const channel = accept()
        channel.pipe(sock).pipe(channel)
        channel.on('close', () => sock.destroy())
        sock.on('error', () => channel.destroy())
      })
    })
  })
})

server.listen(Number(args.get('port') ?? 0), '127.0.0.1', () => {
  process.stdout.write(`${server.address().port}\n`)
})
process.on('SIGTERM', () => {
  for (const c of clients) c.end()
  server.close(() => process.exit(0))
  // A client that does not hang up must not keep the fixture alive.
  setTimeout(() => process.exit(0), 500).unref()
})
