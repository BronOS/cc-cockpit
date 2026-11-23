// The gateway's `/u/` route (design-upload.md §3.2, §3.4, plan Task 5) through the real listener: PUT
// admitted there alone, the Origin and `Sec-Fetch-Site` checks, the cookie and its key, the token's
// device, a guest's role read live per chunk (a read guest's 404 the same bytes as a guess and as a
// route that does not exist), `Content-Length` required and capped, the offset (409 `expected`), a body
// cut mid-chunk and one cut by the request bound (408) truncated back and retried, the idle expiry, every
// teardown mid-chunk deleting the temp, a reconnect continuing, None mode on the token alone, and the
// access log's line per file. A real `Uploads` and `UploadWriter` over a temp project, a real `WebAuth`
// and `GuestStore`; real signed-in devices.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { request } from 'node:http'
import { connect, createServer, type AddressInfo } from 'node:net'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as wsModule from 'ws'
import { UPLOAD_DISK_FULL_TEXT, UploadWriter, type UploadWriterFs } from '../../src/main/files/upload-writer'
import { Uploads } from '../../src/main/files/uploads'
import { fakeSecretStore } from '../../src/main/secrets/secret-store'
import { AccessLog } from '../../src/main/web/access-log'
import { WebAuth } from '../../src/main/web/auth'
import { DeviceStore } from '../../src/main/web/devices'
import { WebGateway, type GatewayDeps, type UploadRoute } from '../../src/main/web/gateway'
import { GuestStore } from '../../src/main/web/guests'
import { webAccessOf } from '../../src/main/web/settings'
import { UPLOAD_CHUNK_MAX_BYTES, UPLOAD_IDLE_MS, UPLOAD_TEMP_PREFIX } from '../../src/shared/uploads'
import { DEVICE_KEY_HEADER, INVITE_PATH, SIGN_IN_LINK_PATH, WS_KEY_PROTOCOL_PREFIX, WS_PROTOCOL, type WebInviteReply } from '../../src/shared/web-protocol'
import { writeFakeShellDir } from '../fakes/fake-shell-dir'

const WINDOW = 3

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** A signed-in browser: its cookie, origin key and device id. */
interface Browser {
  cookie: string
  key: string
  deviceId: string
}

interface Setup {
  gw: WebGateway
  port: number
  host: string
  origin: string
  root: string
  proj: string
  uploads: Uploads
  writer: UploadWriter
  accessLog: AccessLog
  auth: WebAuth
  devices: DeviceStore
  guests: GuestStore
  logs: string[]
  owner: Browser
}

let gateway: WebGateway | undefined
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await gateway?.stop()
  gateway = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function send(port: number, opts: { method: string; path: string; headers: Record<string, string>; body?: Buffer | string }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers, agent: false }, (res) => {
      let body = ''
      res.on('data', (d: Buffer) => (body += d.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

async function setup(opts: { mode?: 'link' | 'none'; deps?: Partial<GatewayDeps>; noUploads?: boolean; writerFs?: Partial<UploadWriterFs> } = {}): Promise<Setup> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-upload-route-')))
  dirs.push(root)
  const proj = join(root, 'proj')
  const data = join(root, 'data')
  for (const d of [proj, data]) mkdirSync(d)
  const logs: string[] = []
  // The wiring's cycle: Uploads takes the writer, the writer reads Uploads through a getter.
  const ref: { uploads?: Uploads } = {}
  const writer = new UploadWriter({
    grants: () => ref.uploads as Uploads,
    projectRoot: () => proj,
    tempsFile: join(data, 'uploads', 'temps.json'),
    log: (line) => logs.push(line),
    ...(opts.writerFs ? { fs: opts.writerFs } : {})
  })
  const uploads = new Uploads({
    projectRoot: (id) => (id === WINDOW ? proj : undefined),
    dataDir: data,
    writer,
    statfs: async () => ({ bavail: 100 * 1024 ** 3, bsize: 1 }),
    platform: 'linux',
    log: (line) => logs.push(line)
  })
  ref.uploads = uploads
  const route: UploadRoute = {
    grant: (token) => uploads.grant(token),
    writeChunk: (token, offset, body, length) => writer.writeChunk(token, offset, body, length),
    dropDevice: (id) => uploads.dropDevice(id),
    dropAll: () => uploads.dropAll()
  }
  const port = await freePort()
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  const accessLog = new AccessLog()
  const devices = new DeviceStore({ filePath: join(data, 'web-access.json'), accessLog })
  const auth = new WebAuth({ devices, secrets: fakeSecretStore(), accessLog })
  const guests = new GuestStore({
    devices,
    accessLog,
    mode: () => auth.mode,
    target: () => ({ origin, loopbackOnly: true }),
    tabOf: () => undefined,
    whoOfView: () => undefined,
    closeGuestViews: () => 0,
    guestLive: () => false,
    log: () => {},
    setInterval: () => ({ stop: () => {} })
  })
  const gw = new WebGateway({
    log: (m) => logs.push(m),
    loadWs: async () => wsModule,
    auth,
    accessLog,
    shellDir: writeFakeShellDir(join(root, 'shell')),
    openProjects: () => [{ id: 'p1', name: 'one', path: proj }],
    guests,
    ...(opts.noUploads ? {} : { uploads: route }),
    ...opts.deps
  })
  gateway = gw
  await gw.apply(webAccessOf({ enabled: true, port, mode: 'link' }))
  const s: Setup = { gw, port, host, origin, root, proj, uploads, writer, accessLog, auth, devices, guests, logs, owner: { cookie: '', key: '', deviceId: '' } }
  s.owner = await signIn(s, 'Phone')
  if (opts.mode === 'none') await gw.apply(webAccessOf({ enabled: true, port, mode: 'none' }))
  return s
}

async function signIn(s: Setup, name: string): Promise<Browser> {
  const link = await s.auth.accessLink(s.origin)
  if (!link.ok) throw new Error('no link')
  const res = await send(s.port, {
    method: 'POST',
    path: SIGN_IN_LINK_PATH,
    headers: { Host: s.host, Origin: s.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: link.link.split('#t=')[1], name })
  })
  expect(res.status).toBe(200)
  const reply = JSON.parse(res.body) as { key: string; device: { id: string } }
  return { cookie: String(res.headers['set-cookie']).split(';')[0] ?? '', key: reply.key, deviceId: reply.device.id }
}

/** A guest of p1 with `role`, signed in through its invite. */
async function guestOf(s: Setup, role: 'read' | 'write', name = 'Bob'): Promise<Browser & { guestId: string }> {
  const a = await s.guests.invite('p1', { name, role, scope: 'all', lifetime: 'forever' })
  if (!a.ok) throw new Error(a.error)
  const res = await send(s.port, {
    method: 'POST',
    path: INVITE_PATH,
    headers: { Host: s.host, Origin: s.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: a.link.split('#i=')[1] })
  })
  expect(res.status).toBe(200)
  const reply = JSON.parse(res.body) as Extract<WebInviteReply, { ok: true }>
  return { cookie: String(res.headers['set-cookie']).split(';')[0] ?? '', key: reply.key, deviceId: reply.device.id, guestId: a.guestId }
}

/** One file `name` of `size` bytes in the project folder, begun for `deviceId`: its token. */
async function mint(s: Setup, name: string, size: number, deviceId = s.owner.deviceId): Promise<{ token: string; uploadId: string }> {
  const reply = await s.uploads.begin({ deviceId, windowId: WINDOW }, { panel: 'cockpit.files/tree' }, '', [{ name, size }])
  if ('error' in reply) throw new Error(reply.error)
  const token = reply.tokens?.[0]?.token
  if (!token) throw new Error('no token')
  return { token, uploadId: reply.uploadId }
}

/** The shell's chunk: a same-origin `keyedFetch` PUT with the cookie and the key. */
function put(s: Setup, token: string, offset: number | string, data: Buffer | string, as: Browser | null = s.owner, over: Record<string, string> = {}): Promise<Answer> {
  const body = typeof data === 'string' ? Buffer.from(data) : data
  const auth: Record<string, string> = as ? { Cookie: as.cookie, [DEVICE_KEY_HEADER]: as.key } : {}
  return send(s.port, {
    method: 'PUT',
    path: `/u/${token}?offset=${offset}`,
    headers: { Host: s.host, Origin: s.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Length': String(body.length), ...auth, ...over },
    body
  })
}

/** Headers for a raw request (no Node client defaults): the owner's, same-origin. */
function rawHead(s: Setup, method: string, path: string, extra: string[] = [], as: Browser = s.owner): string {
  return [`${method} ${path} HTTP/1.1`, `Host: ${s.host}`, `Origin: ${s.origin}`, `Cookie: ${as.cookie}`, `${DEVICE_KEY_HEADER}: ${as.key}`, ...extra, '', ''].join('\r\n')
}

/**
 * A raw request whose body goes out a piece at a time (`pieces`, `gapMs` apart) and may stop short:
 * `text()` is everything the server sent until it closed; `cut()` closes the client's side; `errors` the
 * socket's error codes (a reset shows as ECONNRESET or EPIPE); `sentAtAnswer()` how many pieces had gone
 * out when the server's first byte came.
 */
function rawPut(
  s: Setup,
  head: string,
  pieces: Buffer[] = [],
  gapMs = 0
): { text: Promise<string>; cut: () => void; errors: string[]; sentAtAnswer: () => number | undefined } {
  const socket = connect(s.port, '127.0.0.1')
  let out = ''
  const errors: string[] = []
  let i = 0
  let sentAtAnswer: number | undefined
  const text = new Promise<string>((resolve) => {
    socket.on('data', (d: Buffer) => {
      sentAtAnswer ??= i
      out += d.toString()
    })
    socket.on('close', () => resolve(out))
    socket.on('error', (err: NodeJS.ErrnoException) => errors.push(err.code ?? 'error'))
  })
  socket.once('connect', () => {
    socket.write(head)
    const next = (): void => {
      if (i >= pieces.length || socket.destroyed) return
      socket.write(pieces[i++] as Buffer)
      if (gapMs > 0) setTimeout(next, gapMs)
      else next()
    }
    next()
  })
  return { text, cut: () => socket.destroy(), errors, sentAtAnswer: () => sentAtAnswer }
}

/**
 * One raw request on a connection the client keeps open (no `Connection: close` of its own, unlike
 * `agent: false`): the answer's status line and headers, `Date` left out, and its body, read to its
 * Content-Length. What a guest could compare byte for byte.
 */
function rawAnswer(s: Setup, request: string): Promise<{ head: string[]; body: string }> {
  const socket = connect(s.port, '127.0.0.1')
  let out = ''
  return new Promise((resolve, reject) => {
    socket.on('data', (d: Buffer) => {
      out += d.toString()
      const end = out.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = out.slice(0, end).split('\r\n')
      const length = Number(head.find((h) => h.toLowerCase().startsWith('content-length:'))?.split(':')[1] ?? 0)
      const body = out.slice(end + 4)
      if (body.length < length) return
      socket.destroy()
      resolve({ head: head.filter((h) => !h.toLowerCase().startsWith('date:')), body })
    })
    socket.on('error', reject)
    socket.once('connect', () => socket.write(request))
  })
}

function tempsIn(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.startsWith(UPLOAD_TEMP_PREFIX))
}

/** The one temp in the project folder and its size (undefined: none). */
function tempSize(s: Setup): number | undefined {
  const [name] = tempsIn(s.proj)
  return name === undefined ? undefined : statSync(join(s.proj, name)).size
}

function uploadLines(s: Setup): Array<Record<string, unknown>> {
  return s.accessLog.recent().filter((e) => e.event === 'upload') as unknown as Array<Record<string, unknown>>
}

/** No answer, log line or gateway log may carry a host path or a token. */
function expectClean(s: Setup, answers: Answer[], tokens: string[]): void {
  const all = [...answers.map((a) => a.body), ...s.logs, ...s.accessLog.recent().map((e) => JSON.stringify(e))].join('\n')
  expect(all).not.toContain(s.root)
  for (const token of tokens) expect(all).not.toContain(token)
}

const MiB = 1024 * 1024

describe('the /u/ route: a clean upload', () => {
  it('takes chunks at their offsets, commits on the last, answers with the upload headers and logs one line', async () => {
    const s = await setup()
    const { token } = await mint(s, 'a.txt', 10)
    const first = await put(s, token, 0, 'hello')
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body)).toEqual({ received: 5 })
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.headers['x-content-type-options']).toBe('nosniff')
    expect(uploadLines(s)).toEqual([])
    const last = await put(s, token, 5, 'world')
    expect(last.status).toBe(200)
    expect(JSON.parse(last.body)).toEqual({ done: true, name: 'a.txt', path: 'a.txt' })
    expect(readFileSync(join(s.proj, 'a.txt'), 'utf8')).toBe('helloworld')
    expect(tempsIn(s.proj)).toEqual([])
    expect(uploadLines(s)).toEqual([expect.objectContaining({ event: 'upload', device: s.owner.deviceId, name: 'Phone', file: 'a.txt', bytes: 10, detail: 'completed' })])
    // A resend of the last chunk finds the token used: 404, and no second line.
    const again = await put(s, token, 5, 'world')
    expect(again.status).toBe(404)
    expect(uploadLines(s)).toHaveLength(1)
    expectClean(s, [first, last, again], [token])
  })

  it('a resend of the last chunk queued behind it (a Chromium resend) is a 404 and adds no line', async () => {
    const s = await setup()
    const { token } = await mint(s, 'd.txt', 8)
    expect((await put(s, token, 0, 'abcd')).status).toBe(200)
    // The last chunk, held mid-body; its duplicate passes the route's checks (the token is live) and waits
    // on the writer's chain behind it.
    const head = rawHead(s, 'PUT', `/u/${token}?offset=4`, ['Content-Length: 4', 'Connection: close'])
    const socket = connect(s.port, '127.0.0.1')
    let out = ''
    const firstText = new Promise<string>((resolve) => {
      socket.on('data', (d: Buffer) => (out += d.toString()))
      socket.on('close', () => resolve(out))
    })
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    socket.write(head + 'ef')
    await vi.waitFor(() => expect(tempSize(s)).toBe(6))
    const duplicate = put(s, token, 4, 'efgh')
    await new Promise((r) => setTimeout(r, 50))
    socket.write('gh')
    expect(await firstText).toContain('"done":true')
    expect((await duplicate).status).toBe(404)
    expect(readFileSync(join(s.proj, 'd.txt'), 'utf8')).toBe('abcdefgh')
    expect(uploadLines(s)).toEqual([expect.objectContaining({ file: 'd.txt', detail: 'completed' })])
  })

  it('an empty file commits on one zero-length PUT at offset 0', async () => {
    const s = await setup()
    const { token } = await mint(s, '.gitkeep', 0)
    const res = await put(s, token, 0, '')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ done: true, name: '.gitkeep', path: '.gitkeep' })
    expect(statSync(join(s.proj, '.gitkeep')).size).toBe(0)
  })

  it('a reconnect (a new view, same device) continues the upload', async () => {
    const s = await setup()
    const { token } = await mint(s, 'r.bin', 8)
    expect((await put(s, token, 0, 'abcd')).status).toBe(200)
    // The device's view goes and a new one comes (a phone that slept): the token is the device's, not a view's.
    s.gw.setSocketHandler(() => undefined)
    for (let i = 0; i < 2; i++) {
      const client = new wsModule.WebSocket(`ws://${s.host}/ws`, [WS_PROTOCOL, `${WS_KEY_PROTOCOL_PREFIX}${s.owner.key}`], {
        origin: s.origin,
        headers: { Cookie: s.owner.cookie }
      })
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve())
        client.on('error', reject)
      })
      const closed = new Promise((resolve) => client.on('close', resolve))
      client.terminate()
      await closed
    }
    const res = await put(s, token, 4, 'efgh')
    expect(JSON.parse(res.body)).toEqual({ done: true, name: 'r.bin', path: 'r.bin' })
  })
})

describe('the /u/ route: admission and the checks before a byte', () => {
  it('admits PUT for /u/ alone: a PUT elsewhere is 405, another method on /u/ is 405', async () => {
    const s = await setup()
    const { token } = await mint(s, 'a.txt', 3)
    for (const path of ['/', '/api/projects', `/d/${token}`, '/x/u/abc']) {
      const res = await send(s.port, { method: 'PUT', path, headers: { Host: s.host, Origin: s.origin, Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: s.owner.key }, body: 'abc' })
      expect(res.status, path).toBe(405)
    }
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH']) {
      const res = await send(s.port, { method, path: `/u/${token}?offset=0`, headers: { Host: s.host, Origin: s.origin, Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: s.owner.key } })
      expect(res.status, method).toBe(405)
    }
    expect(tempsIn(s.proj)).toEqual([])
    // The token is untouched.
    expect((await put(s, token, 0, 'abc')).status).toBe(200)
  })

  it('refuses another origin, no origin, and a cross-site Sec-Fetch-Site before anything is written', async () => {
    const s = await setup()
    const { token } = await mint(s, 'a.txt', 3)
    expect((await put(s, token, 0, 'abc', s.owner, { Origin: 'http://evil.example' })).status).toBe(403)
    const noOrigin = await send(s.port, {
      method: 'PUT',
      path: `/u/${token}?offset=0`,
      headers: { Host: s.host, Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: s.owner.key, 'Content-Length': '3' },
      body: 'abc'
    })
    expect(noOrigin.status).toBe(403)
    for (const site of ['cross-site', 'same-site', 'none']) {
      expect((await put(s, token, 0, 'abc', s.owner, { 'Sec-Fetch-Site': site })).status, site).toBe(403)
    }
    expect(tempsIn(s.proj)).toEqual([])
    expect(s.logs.join('\n')).toContain('Sec-Fetch-Site "cross-site"')
    // Without the header (a browser that sends none) it goes on.
    const res = await send(s.port, {
      method: 'PUT',
      path: `/u/${token}?offset=0`,
      headers: { Host: s.host, Origin: s.origin, Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: s.owner.key, 'Content-Length': '3' },
      body: 'abc'
    })
    expect(JSON.parse(res.body)).toEqual({ done: true, name: 'a.txt', path: 'a.txt' })
  })

  it('the Origin and Sec-Fetch-Site checks come before the cookie: with no cookie either is 403, not 401', async () => {
    const s = await setup()
    const { token } = await mint(s, 'a.txt', 3)
    const site = await put(s, token, 0, 'abc', null, { 'Sec-Fetch-Site': 'cross-site' })
    expect(site.status).toBe(403)
    expect(JSON.parse(site.body)).toEqual({ error: 'the request came from another site' })
    const origin = await put(s, token, 0, 'abc', null, { Origin: 'http://evil.example' })
    expect(origin.status).toBe(403)
    expect(origin.body).toBe('origin not allowed')
    expect(tempsIn(s.proj)).toEqual([])
  })

  it('needs the cookie and its key: neither, or a cookie with no key, is 401', async () => {
    const s = await setup()
    const { token } = await mint(s, 'a.txt', 3)
    expect((await put(s, token, 0, 'abc', null)).status).toBe(401)
    const noKey = await put(s, token, 0, 'abc', null, { Cookie: s.owner.cookie })
    expect(noKey.status).toBe(401)
    expect(noKey.headers.connection).toBe('close')
    expect((await put(s, token, 0, 'abc', null, { Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: 'wrong' })).status).toBe(401)
    expect(tempsIn(s.proj)).toEqual([])
  })

  it("another device's token answers as an unknown one, and writes nothing", async () => {
    const s = await setup()
    const other = await signIn(s, 'Laptop')
    const { token } = await mint(s, 'a.txt', 3, other.deviceId)
    const foreign = await put(s, token, 0, 'abc')
    const unknown = await put(s, 'A'.repeat(43), 0, 'abc')
    expect(foreign.status).toBe(404)
    expect(foreign.body).toBe(unknown.body)
    expect(JSON.parse(foreign.body)).toEqual({ error: 'no such upload' })
    expect(tempsIn(s.proj)).toEqual([])
    // Its own device's PUT works.
    expect((await put(s, token, 0, 'abc', other)).status).toBe(200)
  })

  it('no uploads wired: a 404 for the owner', async () => {
    const s = await setup({ noUploads: true })
    expect((await put(s, 'A'.repeat(43), 0, 'abc')).status).toBe(404)
  })

  it('Content-Length: a chunked body or none is 400, more than 8 MiB is 413, all unread and closed', async () => {
    const s = await setup()
    const { token } = await mint(s, 'big.bin', UPLOAD_CHUNK_MAX_BYTES + 10)
    const chunked = await new Promise<Answer>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: s.port,
          method: 'PUT',
          path: `/u/${token}?offset=0`,
          headers: { Host: s.host, Origin: s.origin, Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: s.owner.key, 'Transfer-Encoding': 'chunked' },
          agent: false
        },
        (res) => {
          let body = ''
          res.on('data', (d: Buffer) => (body += d.toString()))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
        }
      )
      req.on('error', reject)
      req.write('abc')
      req.end()
    })
    expect(chunked.status).toBe(400)
    const none = await rawPut(s, rawHead(s, 'PUT', `/u/${token}?offset=0`, ['Connection: close'])).text
    expect(none.startsWith('HTTP/1.1 400')).toBe(true)
    // Over the cap: answered from the headers alone, the body never read, the connection closed.
    const over = rawPut(s, rawHead(s, 'PUT', `/u/${token}?offset=0`, [`Content-Length: ${UPLOAD_CHUNK_MAX_BYTES + 1}`]), [Buffer.alloc(1024)])
    const text = await over.text
    expect(text.startsWith('HTTP/1.1 413')).toBe(true)
    expect(text.toLowerCase()).toContain('connection: close')
    expect(tempsIn(s.proj)).toEqual([])
    // Exactly the cap is a chunk.
    expect((await put(s, token, 0, Buffer.alloc(UPLOAD_CHUNK_MAX_BYTES, 1))).status).toBe(200)
  })

  it('the offset: not a count is 400; not what is written is 409 with expected; past the size 413', async () => {
    const s = await setup()
    const { token } = await mint(s, 'a.txt', 6)
    for (const bad of ['-1', '1e3', '+0', '%200', '0x0', '1.0', '']) {
      const res = await put(s, token, bad, 'abc')
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    const missing = await send(s.port, {
      method: 'PUT',
      path: `/u/${token}`,
      headers: { Host: s.host, Origin: s.origin, Cookie: s.owner.cookie, [DEVICE_KEY_HEADER]: s.owner.key, 'Content-Length': '3' },
      body: 'abc'
    })
    expect(missing.status).toBe(400)
    expect((await put(s, token, '0&offset=0', 'abc')).status).toBe(400)
    const gap = await put(s, token, 3, 'abc')
    expect(gap.status).toBe(409)
    expect(JSON.parse(gap.body)).toEqual({ error: 'the next byte expected is 0', expected: 0 })
    expect((await put(s, token, 0, 'abc')).status).toBe(200)
    const overlap = await put(s, token, 1, 'abc')
    expect(JSON.parse(overlap.body)).toMatchObject({ expected: 3 })
    expect((await put(s, token, 3, 'abcd')).status).toBe(413)
    expect(JSON.parse((await put(s, token, 3, 'def')).body)).toMatchObject({ done: true })
    expect(readFileSync(join(s.proj, 'a.txt'), 'utf8')).toBe('abcdef')
  })
})

describe('the /u/ route: guests', () => {
  it("a write guest's PUT is accepted and logged as its device", async () => {
    const s = await setup()
    const g = await guestOf(s, 'write')
    const { token } = await mint(s, 'g.txt', 3, g.deviceId)
    const res = await put(s, token, 0, 'abc', g)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ done: true, name: 'g.txt', path: 'g.txt' })
    expect(uploadLines(s)).toEqual([expect.objectContaining({ device: g.deviceId, name: 'Bob', detail: 'completed' })])
    // Its own token's protocol answers reach it (a resend's 409 is how it resumes).
    const { token: second } = await mint(s, 'h.txt', 6, g.deviceId)
    const gap = await put(s, second, 2, 'abc', g)
    expect(gap.status).toBe(409)
    expect(JSON.parse(gap.body)).toMatchObject({ expected: 0 })
    expectClean(s, [res, gap], [token, second])
  })

  it("a read guest gets the gateway's one 404 for a live token, a guess, and a route that does not exist", async () => {
    const s = await setup()
    const g = await guestOf(s, 'read')
    const { token } = await mint(s, 'g.txt', 3, g.deviceId)
    const live = await put(s, token, 0, 'abc', g)
    const guessed = await put(s, 'A'.repeat(43), 0, 'abc', g)
    const ownerTokenGuess = await put(s, (await mint(s, 'o.txt', 3)).token, 0, 'abc', g)
    const nowhere = await send(s.port, { method: 'GET', path: '/api/nothing', headers: { Host: s.host, Cookie: g.cookie, [DEVICE_KEY_HEADER]: g.key } })
    for (const a of [live, guessed, ownerTokenGuess]) {
      expect(a.status).toBe(404)
      expect(a.body).toBe(nowhere.body)
      expect(a.headers['content-type']).toBe(nowhere.headers['content-type'])
    }
    expect(nowhere.status).toBe(404)
    expect(live.body).toBe(guessed.body)
    expect(live.headers['content-length']).toBe(guessed.headers['content-length'])
    expect(tempsIn(s.proj)).toEqual([])
  })

  it("every guest refusal on /u/ is the guest block's 404 to the header, the connection kept as there", async () => {
    const s = await setup()
    const reader = await guestOf(s, 'read')
    const writer = await guestOf(s, 'write', 'Carol')
    const head = (g: Browser, method: string, path: string, body: string): string =>
      [`${method} ${path} HTTP/1.1`, `Host: ${s.host}`, `Origin: ${s.origin}`, `Cookie: ${g.cookie}`, `${DEVICE_KEY_HEADER}: ${g.key}`, `Content-Length: ${body.length}`, '', body].join('\r\n')
    const nowhere = await rawAnswer(s, head(reader, 'POST', '/api/nothing', 'abc'))
    expect(nowhere.head[0]).toBe('HTTP/1.1 404 Not Found')
    expect(nowhere.head.map((h) => h.toLowerCase())).toContain('connection: keep-alive')
    const { token: readLive } = await mint(s, 'r.txt', 3, reader.deviceId)
    const { token: writerDone } = await mint(s, 'w.txt', 3, writer.deviceId)
    expect((await put(s, writerDone, 0, 'abc', writer)).status).toBe(200)
    const answers = [
      // A read guest: its own live token, a guess, another method.
      await rawAnswer(s, head(reader, 'PUT', `/u/${readLive}?offset=0`, 'abc')),
      await rawAnswer(s, head(reader, 'PUT', `/u/${'A'.repeat(43)}?offset=0`, 'abc')),
      await rawAnswer(s, head(reader, 'POST', `/u/${readLive}?offset=0`, 'abc')),
      // A write guest: a guess, another method, its own token once the file is over.
      await rawAnswer(s, head(writer, 'PUT', `/u/${'A'.repeat(43)}?offset=0`, 'abc')),
      await rawAnswer(s, head(writer, 'POST', `/u/${writerDone}?offset=0`, 'abc')),
      await rawAnswer(s, head(writer, 'PUT', `/u/${writerDone}?offset=0`, 'abc'))
    ]
    // A write guest's own token that ends while its chunk waits behind another (the window closed): the
    // writer's 404 goes out as the same bytes.
    const { token: held } = await mint(s, 'h.bin', 8, writer.deviceId)
    expect((await put(s, held, 0, 'abcd', writer)).status).toBe(200)
    rawPut(s, rawHead(s, 'PUT', `/u/${held}?offset=4`, ['Content-Length: 4'], writer), [Buffer.from('ef')])
    await vi.waitFor(() => expect(tempSize(s)).toBe(6))
    const queued = rawAnswer(s, head(writer, 'PUT', `/u/${held}?offset=4`, 'efgh'))
    await new Promise((r) => setTimeout(r, 50))
    await s.uploads.dropWindow(WINDOW)
    answers.push(await queued)
    for (const a of answers) expect(a).toEqual(nowhere)
    expect(tempsIn(s.proj)).toEqual([])
  })

  it('a write guest changed to read mid-upload: its next chunk is a 404, nothing more written', async () => {
    const s = await setup()
    const g = await guestOf(s, 'write')
    const { token } = await mint(s, 'g.txt', 6, g.deviceId)
    expect((await put(s, token, 0, 'abc', g)).status).toBe(200)
    expect(s.guests.setRole(g.guestId, 'read')).toBe(true)
    const next = await put(s, token, 3, 'def', g)
    expect(next.status).toBe(404)
    expect(next.body).toBe('not found')
    expect(tempSize(s)).toBe(3)
    expect(existsSync(join(s.proj, 'g.txt'))).toBe(false)
  })
})

describe('the /u/ route: cut bodies', () => {
  it('a body cut mid-chunk is truncated back to its offset and the retry from there completes', async () => {
    const s = await setup()
    const { token } = await mint(s, 'c.txt', 8)
    expect((await put(s, token, 0, 'abcd')).status).toBe(200)
    const cut = rawPut(s, rawHead(s, 'PUT', `/u/${token}?offset=4`, ['Content-Length: 4']), [Buffer.from('ef')])
    await vi.waitFor(() => expect(tempSize(s)).toBe(6))
    cut.cut()
    await cut.text
    await vi.waitFor(() => expect(tempSize(s)).toBe(4))
    const retry = await put(s, token, 4, 'efgh')
    expect(JSON.parse(retry.body)).toEqual({ done: true, name: 'c.txt', path: 'c.txt' })
    expect(readFileSync(join(s.proj, 'c.txt'), 'utf8')).toBe('abcdefgh')
  })

  it('the listener runs with the production bound: 30 s per request, checked every 5 s', async () => {
    // The 408 case below shortens both; without them the defaults are what design §3.3 and the client's
    // halving after a cut rely on (Node's own 30 s check interval would cut anywhere in 30-60 s).
    const s = await setup()
    const server = (s.gw as unknown as { server: { connectionsCheckingInterval: number; requestTimeout: number; headersTimeout: number } }).server
    expect(server.connectionsCheckingInterval).toBe(5_000)
    expect(server.requestTimeout).toBe(30_000)
    expect(server.headersTimeout).toBeLessThanOrEqual(30_000)
  })

  it('a body trickled past the request bound is cut with 408, truncated back, and the retry completes', async () => {
    // The bound and Node's check interval shortened: the cut falls within bound + interval, never before.
    const s = await setup({ deps: { requestTimeoutMs: 800, connectionsCheckingMs: 100 } })
    const { token } = await mint(s, 't.bin', 120)
    expect((await put(s, token, 0, Buffer.alloc(20, 1))).status).toBe(200)
    const started = Date.now()
    const slow = rawPut(s, rawHead(s, 'PUT', `/u/${token}?offset=20`, ['Content-Length: 100']), Array.from({ length: 100 }, () => Buffer.alloc(1, 2)), 50)
    const text = await slow.text
    const took = Date.now() - started
    expect(text.startsWith('HTTP/1.1 408')).toBe(true)
    expect(took).toBeGreaterThanOrEqual(700)
    expect(took).toBeLessThan(2_500)
    await vi.waitFor(() => expect(tempSize(s)).toBe(20))
    const retry = await put(s, token, 20, Buffer.alloc(100, 2))
    expect(JSON.parse(retry.body)).toEqual({ done: true, name: 't.bin', path: 't.bin' })
    expect(readFileSync(join(s.proj, 't.bin'))).toEqual(Buffer.concat([Buffer.alloc(20, 1), Buffer.alloc(100, 2)]))
  })
})

describe('the /u/ route: a write that fails mid-body', () => {
  it('disk full on a write: the 507 arrives once the rest of the body is read off, the temp goes, one line', async () => {
    // A write fails past the first 64 KiB of a 4 MiB chunk while most of the body is still on its way.
    // The writer used to leave its loop destroying the request, Node reset the socket, and the client saw
    // a network error, then a 404 on its retry: the reason (the disk is full) never reached the person.
    const s = await setup({
      writerFs: {
        open: async (path, flags, mode) => {
          const handle = await open(path, flags, mode)
          const real = handle.write.bind(handle) as (...args: unknown[]) => Promise<{ bytesWritten: number }>
          let written = 0
          ;(handle as unknown as { write: (...args: unknown[]) => Promise<{ bytesWritten: number }> }).write = async (...args) => {
            if (written >= 64 * 1024) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
            const done = await real(...args)
            written += done.bytesWritten
            return done
          }
          return handle
        }
      }
    })
    const size = 4 * MiB
    const { token, uploadId } = await mint(s, 'full.bin', size)
    const pieces = Array.from({ length: 64 }, () => Buffer.alloc(64 * 1024, 7))
    const sent = rawPut(s, rawHead(s, 'PUT', `/u/${token}?offset=0`, [`Content-Length: ${size}`, 'Connection: close']), pieces, 5)
    const text = await sent.text
    expect(text.startsWith('HTTP/1.1 507')).toBe(true)
    expect(text).toContain(JSON.stringify({ error: UPLOAD_DISK_FULL_TEXT }))
    // Closed after the whole body was read, never reset under a client still sending (over a real link
    // a reset can drop the answer that loopback still delivered).
    expect(sent.errors).toEqual([])
    expect(sent.sentAtAnswer()).toBe(pieces.length)
    expect(tempsIn(s.proj)).toEqual([])
    expect(existsSync(join(s.proj, 'full.bin'))).toBe(false)
    expect(uploadLines(s)).toEqual([expect.objectContaining({ file: 'full.bin', bytes: 0, detail: `cut: ${UPLOAD_DISK_FULL_TEXT}` })])
    expect(s.uploads.outcome({ deviceId: s.owner.deviceId, windowId: WINDOW }, uploadId)?.results.get(0)).toEqual({ ok: false, reason: UPLOAD_DISK_FULL_TEXT })
    // The file is over: a retry finds no such upload (which is why the 507 itself must arrive).
    const retry = await put(s, token, 0, 'x')
    expect(retry.status).toBe(404)
    expectClean(s, [retry], [token])
  })
})

describe('the /u/ route: ends', () => {
  /** A chunk of `c.bin` (8 bytes) sending 2 of its 4 bytes and holding; resolves once they are on disk. */
  async function holding(s: Setup, as: Browser = s.owner): Promise<{ token: string; text: Promise<string> }> {
    const { token } = await mint(s, 'c.bin', 8, as.deviceId)
    expect((await put(s, token, 0, 'abcd', as)).status).toBe(200)
    const held = rawPut(s, rawHead(s, 'PUT', `/u/${token}?offset=4`, ['Content-Length: 4'], as), [Buffer.from('ef')])
    await vi.waitFor(() => expect(tempSize(s)).toBe(6))
    return { token, text: held.text }
  }

  it('a revoke mid-chunk cuts the request and deletes the temp', async () => {
    const s = await setup()
    const { text } = await holding(s)
    expect(s.devices.revoke(s.owner.deviceId)).toBe(true)
    expect(await text).not.toContain('200 OK')
    await vi.waitFor(() => expect(tempsIn(s.proj)).toEqual([]))
    expect(existsSync(join(s.proj, 'c.bin'))).toBe(false)
    await vi.waitFor(() => expect(uploadLines(s)).toEqual([expect.objectContaining({ file: 'c.bin', bytes: 4, detail: 'cut: ended' })]))
  })

  it('Disconnect mid-chunk cuts it and deletes the temp; the device stays signed in', async () => {
    const s = await setup()
    const { token, text } = await holding(s)
    s.gw.disconnectDevice(s.owner.deviceId)
    expect(await text).not.toContain('200 OK')
    await vi.waitFor(() => expect(tempsIn(s.proj)).toEqual([]))
    expect((await put(s, token, 4, 'efgh')).status).toBe(404)
    // A new upload works.
    const { token: again } = await mint(s, 'n.txt', 2)
    expect((await put(s, again, 0, 'ok')).status).toBe(200)
  })

  it('None mode: a None token on the token alone; leaving None ends it mid-chunk', async () => {
    const s = await setup({ mode: 'none' })
    const { token } = await mint(s, 'n.txt', 8, 'none')
    const first = await send(s.port, {
      method: 'PUT',
      path: `/u/${token}?offset=0`,
      headers: { Host: s.host, Origin: s.origin, 'Content-Length': '4' },
      body: 'abcd'
    })
    expect(first.status).toBe(200)
    // A signed-in device's token in None mode still needs its cookie and key: without them the caller is `none`.
    const own = await mint(s, 'o.txt', 2)
    const anonymous = await send(s.port, { method: 'PUT', path: `/u/${own.token}?offset=0`, headers: { Host: s.host, Origin: s.origin, 'Content-Length': '2' }, body: 'ok' })
    expect(anonymous.status).toBe(404)
    expect((await put(s, own.token, 0, 'ok')).status).toBe(200)
    const held = rawPut(s, [`PUT /u/${token}?offset=4 HTTP/1.1`, `Host: ${s.host}`, `Origin: ${s.origin}`, 'Content-Length: 4', '', ''].join('\r\n'), [Buffer.from('ef')])
    await vi.waitFor(() => expect(tempSize(s)).toBe(6))
    await s.gw.apply(webAccessOf({ enabled: true, port: s.port, mode: 'link' }))
    expect(await held.text).not.toContain('200 OK')
    await vi.waitFor(() => expect(tempsIn(s.proj)).toEqual([]))
    expect(uploadLines(s)).toEqual(expect.arrayContaining([expect.objectContaining({ device: 'none', name: 'No sign-in', detail: 'cut: ended' })]))
  })

  it("the gateway's stop cuts the chunk and the temp is gone when the stop resolves", async () => {
    const s = await setup()
    const { token, text } = await holding(s)
    await s.gw.stop()
    expect(tempsIn(s.proj)).toEqual([])
    expect(s.uploads.grant(token)).toBeUndefined()
    expect(await text).not.toContain('200 OK')
  })

  it("the window's close (dropWindow) cuts the chunk and deletes the temp", async () => {
    const s = await setup()
    const { token, text } = await holding(s)
    await s.uploads.dropWindow(WINDOW)
    expect(tempsIn(s.proj)).toEqual([])
    expect(await text).not.toContain('200 OK')
    expect((await put(s, token, 4, 'efgh')).status).toBe(404)
  })

  it('the idle clock: no bytes for the upload for 60 s ends it and deletes the temp', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const s = await setup()
    const { token } = await mint(s, 'i.txt', 8)
    expect((await put(s, token, 0, 'abcd')).status).toBe(200)
    expect(tempSize(s)).toBe(4)
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1_000)
    expect(s.uploads.grant(token)).toBeDefined()
    await vi.advanceTimersByTimeAsync(2_000)
    vi.useRealTimers()
    await vi.waitFor(() => expect(tempsIn(s.proj)).toEqual([]))
    expect((await put(s, token, 4, 'efgh')).status).toBe(404)
  })

  it('a large chunk at 1 MiB pieces goes through whole', async () => {
    const s = await setup()
    const size = 3 * MiB + 5
    const data = Buffer.alloc(size)
    for (let i = 0; i < size; i++) data[i] = i % 251
    const { token } = await mint(s, 'big.bin', size)
    let offset = 0
    while (offset < size) {
      const end = Math.min(size, offset + MiB)
      const res = await put(s, token, offset, data.subarray(offset, end))
      expect(res.status).toBe(200)
      offset = end
    }
    expect(readFileSync(join(s.proj, 'big.bin')).equals(data)).toBe(true)
  })
})
