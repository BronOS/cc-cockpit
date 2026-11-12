// The built ssh2 adapter under Electron (design-remote-desktop.md §8 "The library", §11): Electron's
// BoringSSL has no chacha20-poly1305, so a vitest run under plain Node proves nothing about the
// ciphers the app will negotiate. This loads out/main/ssh-client.js, the very bundle that ships (ssh2
// inside, its native parts stubbed out by electron.vite.config.ts), and against an in-process ssh2
// Server on a random loopback port does a handshake with a password sign-in, an exec and a
// forwardOut to a local echo server. Prints the negotiated algorithms and exits 0, or 1 on any failure.
//
//   node scripts/ssh2-electron-check.mjs              the built app in out/ (npm run build first),
//                                                     run as this repo's Electron's main process
//   node scripts/ssh2-electron-check.mjs <executable> a packaged cc-cockpit (npm run package:dir):
//                                                     its own app.asar's out/main/ssh-client.js, run
//                                                     by that executable as Node (ELECTRON_RUN_AS_NODE,
//                                                     as `ccc` runs): a packaged app takes no script
//                                                     as its main, and the crypto (BoringSSL) is the
//                                                     same either way
//
// On Linux the Electron-main run gets the server's headless switches and no display, so it needs
// none. The ssh2 Server comes from this repo's node_modules (a devDependency): it runs under the same
// Electron, so both ends have only what BoringSSL has, and the client's list decides the cipher.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const self = fileURLToPath(import.meta.url)
const requireHere = createRequire(import.meta.url)

// --- the launcher (plain node) -------------------------------------------------------------------
if (!process.versions.electron) {
  const executable = process.argv[2]
  const env = { ...process.env }
  // Electron must find no display or session bus (the check needs neither), and nothing of the
  // person's agent or ssh setup: the adapter is given every option explicitly.
  if (process.platform === 'linux') {
    delete env.DISPLAY
    delete env.WAYLAND_DISPLAY
  }
  delete env.SSH_AUTH_SOCK
  let command
  let args
  if (executable) {
    const resources = process.platform === 'darwin' ? join(dirname(executable), '..', 'Resources') : join(dirname(executable), 'resources')
    env.ELECTRON_RUN_AS_NODE = '1'
    env.CC_SSH2_CHECK_BUNDLE = join(resources, 'app.asar', 'out', 'main', 'ssh-client.js')
    env.CC_SSH2_CHECK_MODE = 'packaged executable as Node'
    command = executable
    args = [self]
  } else {
    delete env.ELECTRON_RUN_AS_NODE
    env.CC_SSH2_CHECK_BUNDLE = join(root, 'out', 'main', 'ssh-client.js')
    env.CC_SSH2_CHECK_MODE = "this repo's Electron as main"
    command = requireHere('electron')
    const switches = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []
    args = [...switches, self]
  }
  const child = spawn(command, args, { stdio: 'inherit', env })
  const code = await new Promise((done) => {
    child.on('error', (err) => {
      console.error(`ssh2 check: could not start ${command}: ${err.message}`)
      done(1)
    })
    child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0)))
  })
  process.exit(code)
}

// --- under Electron --------------------------------------------------------------------------------
const asMain = process.type === 'browser'
const electronApp = asMain ? requireHere('electron').app : undefined
// Electron as main would make ~/.config/Electron otherwise.
const userData = asMain ? mkdtempSync(join(tmpdir(), 'ssh2-check-')) : undefined
if (electronApp && userData) electronApp.setPath('userData', userData)

function finish(code) {
  if (userData) rmSync(userData, { recursive: true, force: true })
  if (electronApp) electronApp.exit(code)
  else process.exit(code)
}

const DEADLINE_MS = 30_000
setTimeout(() => {
  console.error(`ssh2 check: no result after ${DEADLINE_MS} ms`)
  finish(1)
}, DEADLINE_MS).unref()

async function run() {
  const crypto = await import('node:crypto')
  const bundlePath = process.env.CC_SSH2_CHECK_BUNDLE
  const adapter = createRequire(import.meta.url)(bundlePath)
  for (const name of ['dial', 'parseKey']) {
    if (typeof adapter[name] !== 'function') throw new Error(`${bundlePath} has no ${name} export`)
  }
  // The server side: ssh2 from node_modules, not the bundle (main never has Server).
  const { Server, utils } = createRequire(join(root, 'package.json'))('ssh2')

  const hostKey = utils.generateKeyPairSync('ed25519')
  const hostBlob = Buffer.from(hostKey.public.split(' ')[1], 'base64')
  const password = 'check-password'
  let negotiated
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on('error', () => {})
    client.on('handshake', (n) => {
      negotiated = n
    })
    client.on('authentication', (ctx) => {
      if (ctx.username === 'checker' && ctx.method === 'password' && ctx.password === password) return ctx.accept()
      ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          stream.resume()
          stream.write(`ran: ${info.command}`)
          stream.exit(7)
          stream.end()
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        const sock = connect(info.destPort, '127.0.0.1')
        sock.once('error', () => reject())
        sock.once('connect', () => {
          const channel = accept()
          channel.pipe(sock).pipe(channel)
          channel.on('close', () => sock.destroy())
        })
      })
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const echo = createServer((sock) => sock.pipe(sock))
  await new Promise((done) => echo.listen(0, '127.0.0.1', done))

  let verifierSawHostKey = false
  let sent = false
  const conn = await adapter.dial({
    host: '127.0.0.1',
    port: server.address().port,
    username: 'checker',
    readyTimeout: 10_000,
    hostVerifier: (key) => {
      verifierSawHostKey = key.equals(hostBlob)
      return verifierSawHostKey
    },
    authHandler: (left) => {
      if (left === null) return { type: 'none' }
      if (!sent && left.includes('password')) {
        sent = true
        return { type: 'password', password }
      }
      return false
    }
  })
  const exec = await conn.exec('ccc web status --json', { maxBytes: 4096, timeoutMs: 5000 })
  if (exec.stdout !== 'ran: ccc web status --json' || exec.code !== 7) throw new Error(`exec: unexpected ${JSON.stringify(exec)}`)
  const channel = await conn.forwardOut(40000, echo.address().port)
  const echoed = await new Promise((done, fail) => {
    channel.once('data', (d) => done(d.toString()))
    channel.once('error', fail)
    channel.write('ping')
  })
  if (echoed !== 'ping') throw new Error(`forwardOut: echoed ${JSON.stringify(echoed)}`)
  channel.destroy()
  const closed = new Promise((done) => conn.onClose(done))
  conn.end()
  await closed
  echo.close()
  server.close()

  const ciphers = crypto.getCiphers()
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: process.env.CC_SSH2_CHECK_MODE,
        bundle: bundlePath,
        electron: process.versions.electron,
        chacha20InCrypto: ciphers.includes('chacha20-poly1305') || ciphers.includes('chacha20'),
        hostKeyVerified: verifierSawHostKey,
        negotiated: {
          kex: negotiated?.kex,
          serverHostKey: negotiated?.serverHostKey,
          cipher: negotiated?.cs?.cipher,
          mac: negotiated?.cs?.mac || '(AEAD)'
        },
        exec,
        forwardOut: echoed
      },
      null,
      2
    )
  )
}

const start = asMain ? electronApp.whenReady() : Promise.resolve()
start
  .then(run)
  .then(
    () => finish(0),
    (err) => {
      console.error(`ssh2 check failed: ${err?.stack ?? err}`)
      finish(1)
    }
  )
