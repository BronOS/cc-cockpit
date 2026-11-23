// The cost of web access's headless terminals to main (design-web.md §5.2 "Cost", §7a): the reason
// they run in a worker thread. The spike parsed in main and measured 8 flooded tabs stalling main's
// event loop for about 97 ms at p50; with the worker, main only numbers and posts the chunks.
//
//   node --expose-gc scripts/web-terminal-bench.mjs [tabs=8] [seconds=5] [p99 limit ms=20]
//
// Bundles the real TerminalMirror (src/main/terminals/mirror.ts) and the real worker
// (mirror-worker.ts) with esbuild, xterm packages external, starts the worker with worker_threads
// as the app does, and feeds several tabs Claude-like TUI output (answer lines scrolling into the
// scrollback, status and prompt redraws inside synchronized output) in PtyService-sized chunks.
// Reports, all measured on main's thread:
//   1. flooded: every tab gets a FLUSH_BYTES chunk every FLUSH_MS (the most PtyService delivers),
//      held back only while the tab's unparsed backlog is over HIGH_WATER (a `cat bigfile` in every
//      tab at once): event-loop delay and utilization, and the worker's parse throughput;
//   2. paced: a busy-Claude rate per tab;
//   3. snapshot: an inspect (serialize at full scrollback, in the worker) per tab, main's delay meanwhile;
//   4. memory: the process's RSS growth (the worker's heap is not in main's heap).
//   5. streamed webview (design-web-browser.md §3.3, Task 5 of plan 20261111-streamed-webviews.md):
//      phase 1's flood again while an off-screen page animates (a full-viewport canvas repainted
//      every animation frame, 1280x800 and then 1920x1080, the encode area cap) and the real
//      FrameStream (src/main/webview/frame-stream.ts) encodes its paints and sends them to one fake
//      viewer, through the real WebviewViewers, over a fake socket that drains at VIEWER_RATE: main's
//      delay meanwhile, and the stream's encode cost and frame rate.
//   6. group join (design.md of team run 001 §1 "Web and cost"): a browser selects a group of 4 busy
//      Claude tabs, so main serializes four snapshots (the worker's inspect, at full scrollback) and
//      sends them through a fake socket that drains at VIEWER_RATE. Two orders: all four at once, and
//      the design's (the focused pane first, the rest one at a time after the previous snapshot left
//      the socket). Reports main's p99 delay, the peak unsent bytes in the socket and the time until
//      the last snapshot is out; the staged order must stay under SOCKET_HIGH_WATER (32 MiB, the
//      limit at which connection.ts closes a browser to resync) and keep main's p99 under the limit.
//      This models what main does for a join (inspect + send) on the real mirror; it does not drive
//      ViewTerminals itself.
//   7. zip download (design-download.md, plan 20261114-download.md Task 12): the flood again while the
//      real zip writer (src/main/files/zip-writer.ts) streams a 1 GiB zip through `pipeline` to a
//      draining sink (a synchronous one: the highest chunk rate, no back-pressure, no walk, no real
//      res.write): main's delay meanwhile and the zip's throughput. The flood runs for the whole zip.
//      The tree is one 16 MiB file (half Claude-like text, half random bytes) listed 64 times under
//      different names, so the disk holds 16 MiB, not 1 GiB; the phase throws when nothing was zipped.
//   8. many streamed webviews (backlog offscreen-frame-area-cap): N animated pages at once (one fake
//      viewer each, the flood beside them) at 30 fps: main's p99/max delay, frames encoded per second
//      and bytes per second. With the 4th argument `sweep` it first prints the table without the
//      budget (N = 1, 4, 8, 12 at 1280x800 and 1920x1080, informational); always it runs 12 pages
//      at 1920x1080 under the real FrameBudget (src/main/webview/frame-budget.ts), which must pass.
//   9. upload (design-upload.md §7, plan 20261122-upload.md Task 13): the flood again while the real
//      UploadWriter (src/main/files/upload-writer.ts) takes a 1 GiB file in 8 MiB PUTs (the chunk cap) over
//      loopback, from a client in this process to a plain http server that hands each request to
//      `writeChunk` as the gateway's `/u/` route does. The real gateway needs a device store, cookies and
//      secret hashes, which are not cheap to stand up here, so the route itself is not in the loop; the
//      request parsing, the socket and the writer's body loop with its fs writes and commit are. The file
//      lives in a temp dir that is deleted at the end; the phase throws when 1 GiB is not at its name.
// Exits 1 when phase 1's, 5's, 6's, 7's, 8's or 9's p99 delay is over the limit, so a change that puts parsing back
// on main, or lets frames take main from the terminals, fails the bench.
//
// It runs as Electron's main process (the off-screen page needs Electron): started with node, it
// starts itself again under this repo's Electron (on Linux with the server's headless switches,
// `--ozone-platform=headless --disable-gpu`, so no display is needed) and exits with its status.
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer, Agent } from 'node:http'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- under Electron ------------------------------------------------------------------------------
// Started with node: run again as Electron's main (the arguments travel in the environment, since
// Electron puts its own switches into argv) and exit with its status.
if (!process.versions.electron) {
  const electronPath = createRequire(import.meta.url)('electron')
  const switches = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []
  const env = { ...process.env, CC_TERMINAL_BENCH_ARGS: JSON.stringify(process.argv.slice(2)) }
  // A desktop-session Electron must not find a display or the session bus (as the server runs).
  if (process.platform === 'linux') {
    delete env.DISPLAY
    delete env.WAYLAND_DISPLAY
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...switches, '--js-flags=--expose-gc', fileURLToPath(import.meta.url)], { stdio: 'inherit', env })
  const code = await new Promise((done) => child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0))))
  process.exit(code)
}
const { app, BrowserWindow } = createRequire(import.meta.url)('electron')
const args = JSON.parse(process.env.CC_TERMINAL_BENCH_ARGS ?? '[]')
const TABS = Number(args[0] ?? 8)
const SECONDS = Number(args[1] ?? 5)
const P99_LIMIT_MS = Number(args[2] ?? 20)
const SWEEP = args[3] === 'sweep'
/** The fake viewer's socket drains at this many bytes per second (a good Wi-Fi or a LAN). */
const VIEWER_RATE = 8 * 1024 * 1024
const COLS = 120
const ROWS = 40
const FLUSH_MS = 8
const FLUSH_BYTES = 64 * 1024
const HIGH_WATER = 1024 * 1024

// --- Claude-like output ----------------------------------------------------------------------------
const ESC = '\x1b'
let state = 1
const rand = () => {
  state = (state * 1664525 + 1013904223) >>> 0
  return state / 2 ** 32
}
const words = ['the', 'function', 'returns', 'a', 'Promise', 'that', 'resolves', 'when', 'parsed', 'snapshot', 'view', 'mirror', '`seq`', 'chunk', 'terminal', '漢字', '✓']
function answerLine() {
  let s = ''
  while (s.length < 40 + rand() * 70) s += words[Math.floor(rand() * words.length)] + ' '
  const color = rand() < 0.3 ? `${ESC}[38;2;${Math.floor(rand() * 255)};180;120m` : ''
  return `${color}  ${s.trimEnd()}${ESC}[0m\r\n`
}
let frame = 0
function redraw() {
  frame++
  let s = `${ESC}[?2026h${ESC}[6A${ESC}[J`
  const lines = Math.floor(rand() * 4)
  for (let i = 0; i < lines; i++) s += answerLine()
  s += `${ESC}[38;5;174m✻ Thinking… (${frame % 300}s · ↑ ${(frame * 13) % 9000} tokens · esc to interrupt)${ESC}[0m\r\n\r\n`
  s += `${ESC}[2m╭${'─'.repeat(COLS - 2)}╮${ESC}[0m\r\n`
  s += `${ESC}[2m│${ESC}[0m > ${'typed text '.slice(0, frame % 11)}${' '.repeat(COLS - 5 - (frame % 11))}${ESC}[2m│${ESC}[0m\r\n`
  s += `${ESC}[2m╰${'─'.repeat(COLS - 2)}╯${ESC}[0m\r\n`
  s += `  ${ESC}[2m⏵⏵ accept edits on (shift+tab to cycle)${ESC}[0m${ESC}[?2026l`
  return s
}
let text = `${ESC}[?2004h${ESC}[?1004h${ESC}[?25l` + '\r\n'.repeat(6)
while (text.length < 4 * 1024 * 1024) text += redraw()
// Each tab reads the text as an endless loop from its own offset: its stream stays contiguous (a
// sequence cut by a chunk boundary continues in the next chunk, as from a pty), and the text ends
// on a whole redraw, so wrapping around is seamless.
const offsets = new Map()
function next(id, size) {
  let pos = offsets.get(id) ?? 0
  let chunk = ''
  while (chunk.length < size) {
    const piece = text.slice(pos, pos + size - chunk.length)
    chunk += piece
    pos = (pos + piece.length) % text.length
  }
  offsets.set(id, pos)
  return chunk
}

const ms = (ns) => (ns / 1e6).toFixed(1)
const mib = (n) => (n / 1024 / 1024).toFixed(1)
function gc() {
  if (globalThis.gc) {
    globalThis.gc()
    globalThis.gc()
  }
}

// Set up in main(): Electron's main may not await at the top level before `ready` (it would never come).
let mirror
let ids

/** Run `tick` every FLUSH_MS for `seconds`, then wait for the worker; main's delay meanwhile. */
async function measure(seconds, tick, stop) {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const t0 = performance.now()
  // The last tick's end: the drain is measured from it, since `stop` can run the flood well past
  // `seconds` (a zip of 17 s in a 5 s phase would otherwise count 12 s of flood as the worker's).
  let lastTick = t0
  await new Promise((done) => {
    const timer = setInterval(() => {
      tick()
      lastTick = performance.now()
      // `stop` extends the phase past `seconds` (the zip's end); it never shortens it.
      if (lastTick - t0 > seconds * 1000 && (!stop || stop())) {
        clearInterval(timer)
        done()
      }
    }, FLUSH_MS)
  })
  await Promise.all(ids.map((id) => mirror.whenParsed(id)))
  h.disable()
  return {
    p50: h.percentile(50),
    p99: h.percentile(99),
    max: h.max,
    drainedMs: Math.max(0, performance.now() - lastTick)
  }
}
// No event-loop utilization: under Electron, main's loop is Chromium's and Node's figure reads 0.
const line = (r) =>
  `event-loop delay p50 ${ms(r.p50)} ms, p99 ${ms(r.p99)} ms, max ${ms(r.max)} ms; worker done ${r.drainedMs.toFixed(0)} ms after the last chunk`

/** Bundle `entry` (a path, or `{ contents }` of a module in the repo root) as CommonJS into tmp/name. */
async function bundle(tmp, name, entry) {
  const out = await build({
    ...(typeof entry === 'string' ? { entryPoints: [join(root, entry)] } : { stdin: { contents: entry.contents, resolveDir: root, loader: 'ts' } }),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['@xterm/*', 'electron'],
    logLevel: 'warning'
  })
  writeFileSync(join(tmp, name), out.outputFiles[0].text)
}

/** One flooded tick for every tab, as phase 1 (held back past HIGH_WATER). */
function floodTick(count) {
  for (const id of ids) {
    if (mirror.backlog(id) > HIGH_WATER) continue
    mirror.data(id, next(id, FLUSH_BYTES))
    count.posted += FLUSH_BYTES
  }
}

// --- the animated page and the fake viewer (phase 5) -----------------------------------------------
// A busy page: a full-viewport canvas redrawn every animation frame (a moving gradient, a few hundred
// moving shapes, lines of text), so every paint is a whole new frame with photo-like and flat areas.
const ANIMATED_PAGE = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}canvas{display:block}</style>
<canvas id="c"></canvas><script>
const c = document.getElementById('c'), g = c.getContext('2d')
let t = 0
function frame() {
  if (c.width !== innerWidth || c.height !== innerHeight) { c.width = innerWidth; c.height = innerHeight }
  const w = c.width, h = c.height
  const bg = g.createLinearGradient(0, 0, w, h)
  bg.addColorStop(0, 'hsl(' + (t % 360) + ',60%,40%)')
  bg.addColorStop(1, 'hsl(' + ((t + 180) % 360) + ',60%,60%)')
  g.fillStyle = bg
  g.fillRect(0, 0, w, h)
  for (let i = 0; i < 300; i++) {
    g.fillStyle = 'hsla(' + ((i * 37 + t) % 360) + ',70%,55%,0.7)'
    g.beginPath()
    g.arc((i * 97 + t * (1 + (i % 5))) % w, (i * 53 + t * (1 + (i % 3))) % h, 6 + (i % 20), 0, 7)
    g.fill()
  }
  g.fillStyle = '#fff'
  g.font = '14px sans-serif'
  for (let y = 20; y < h; y += 22) g.fillText('frame ' + t + ' · the quick brown fox jumps over the lazy dog · ' + y, 12, y)
  t++
  requestAnimationFrame(frame)
}
frame()
</script>`

/** A browser's socket as the stream sees it: bytes leave at VIEWER_RATE. */
class FakeSocket {
  buffered = 0
  at = performance.now()
  frames = 0
  bytes = 0
  settle() {
    const now = performance.now()
    this.buffered = Math.max(0, this.buffered - ((now - this.at) * VIEWER_RATE) / 1000)
    this.at = now
  }
  send(frame) {
    this.settle()
    this.buffered += frame.byteLength
    this.frames++
    this.bytes += frame.byteLength
    return true
  }
  bufferedAmount() {
    this.settle()
    return this.buffered
  }
}

/**
 * Phase 6: the 4 tabs of a group joined at once by one browser, while the tabs keep streaming a paced
 * Claude-like load. `staged`: the focused pane's snapshot first, the others one at a time after the
 * previous one left the socket (the buffer is back under FRAME_DRAINED_BYTES-like 256 KiB); not staged:
 * all inspects and sends at once. Peak unsent bytes and the time to the last snapshot are the result.
 */
async function groupJoin(staged) {
  const GROUP = ids.slice(0, 4)
  const SOCKET_HIGH_WATER = 32 * 1024 * 1024
  const DRAINED = 256 * 1024
  const socket = new FakeSocket()
  let peak = 0
  const track = setInterval(() => {
    peak = Math.max(peak, socket.bufferedAmount())
  }, 2)
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const t0 = performance.now()
  const rate = 64 * 1024
  const perTick = Math.max(1, Math.round((rate * FLUSH_MS) / 1000))
  const feed = setInterval(() => {
    for (const id of ids) mirror.data(id, next(id, perTick))
  }, FLUSH_MS)
  const sendSnapshot = async (id) => {
    const state = await mirror.inspect(id)
    // What goes on the wire: the serialized screen as UTF-8 (the page's snapshot message).
    if (state) socket.send({ byteLength: Buffer.byteLength(state.data) })
    peak = Math.max(peak, socket.bufferedAmount())
  }
  if (staged) {
    await sendSnapshot(GROUP[0])
    for (const id of GROUP.slice(1)) {
      while (socket.bufferedAmount() > DRAINED) await new Promise((r) => setTimeout(r, 2))
      await sendSnapshot(id)
    }
  } else {
    await Promise.all(GROUP.map(sendSnapshot))
  }
  while (socket.bufferedAmount() > 0) await new Promise((r) => setTimeout(r, 2))
  const lastMs = performance.now() - t0
  clearInterval(feed)
  clearInterval(track)
  h.disable()
  await Promise.all(ids.map((id) => mirror.whenParsed(id)))
  console.log(
    `\n6. group join (${staged ? 'staged, design order' : 'all at once'}): 4 snapshots, ${socket.frames} sent (${mib(socket.bytes)} MiB), ` +
      `peak unsent ${mib(peak)} MiB (limit ${mib(SOCKET_HIGH_WATER)}), last snapshot out after ${lastMs.toFixed(0)} ms; main's delay p99 ${ms(h.percentile(99))} ms, max ${ms(h.max)} ms`
  )
  return { p99: h.percentile(99), peak, lastMs, limit: SOCKET_HIGH_WATER }
}

/**
 * Phase 7: the flood beside a 1 GiB zip made by the real zip writer and drained by a sink that
 * discards, until the zip ends (at least SECONDS; measure() ends on both). The zip's deflate runs on the libuv pool, so what
 * could reach main is the generator's per-chunk hops and the file reads' completions.
 */
async function zipDownload(lib, tmp) {
  const FILE_BYTES = 16 * 1024 * 1024
  const COPIES = 64
  const dir = join(tmp, 'zip-tree')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'big.bin')
  const buf = Buffer.alloc(FILE_BYTES)
  // `text` is shorter than half the file: repeat it, or the gap would stay the zeros of alloc.
  for (let at = 0; at < FILE_BYTES / 2; ) at += buf.write(text.slice(0, FILE_BYTES / 2 - at), at, 'latin1')
  for (let i = FILE_BYTES / 2; i < FILE_BYTES; i++) buf[i] = Math.floor(rand() * 256)
  writeFileSync(file, buf)
  const stat = statSync(file)
  async function* entries() {
    for (let i = 0; i < COPIES; i++) yield { kind: 'file', path: file, name: `tree/big-${i}.bin`, stat }
  }
  let zipped = 0
  let chunks = 0
  const skipped = {}
  const sink = new Writable({
    highWaterMark: 1024 * 1024,
    write(chunk, _enc, cb) {
      zipped += chunk.length
      chunks++
      cb()
    }
  })
  let done = false
  const t0 = performance.now()
  const zip = pipeline(lib.zipEntries(entries(), { maxBytes: 4 * 1024 * 1024 * 1024, skipped }), sink).finally(() => {
    done = true
  })
  const count = { posted: 0 }
  const r = await measure(SECONDS, () => floodTick(count), () => done)
  await zip
  const seconds = (performance.now() - t0) / 1000
  // zipEntries skips a file it cannot open verified (a symlinked checkout makes every path 'changed'):
  // without this check the phase would pass with nothing zipped.
  if (Object.keys(skipped).length > 0 || zipped < (FILE_BYTES * COPIES) / 2) {
    throw new Error(`7. zip download zipped ${mib(zipped)} MiB, skipped ${JSON.stringify(skipped)}: the bench tree was not read (a symlink above ${tmp}?)`)
  }
  console.log(
    `\n7. zip download + flooded: ${mib(FILE_BYTES * COPIES)} MiB in, ${mib(zipped)} MiB zip out (${chunks} chunks) in ${seconds.toFixed(1)} s = ` +
      `${(FILE_BYTES * COPIES / 1024 / 1024 / seconds).toFixed(0)} MiB/s; ${mib(count.posted)} MiB parsed meanwhile`
  )
  console.log(`   ${line(r)}`)
  return r
}

/**
 * Phase 9: the flood beside a 1 GiB upload through the real UploadWriter, in 8 MiB PUTs over loopback,
 * one at a time as the page sends them. The writes are fs calls on the libuv pool; what could reach
 * main is the request's data events, the per-piece awaits and the commit's link. Not measured: the
 * temps record's synchronous flush at a file's first chunk (mkdir, open, write, fsync, rename on main),
 * which runs once per file, so one 1 GiB file never shows it in a p99 (an upload of many files pays it each).
 * The measured window is the upload's own (it ends when the last PUT is answered): a longer window
 * would be flood alone and dilute the p99 the gate reads.
 */
async function uploadPhase(lib, tmp) {
  const TOTAL = 1024 * 1024 * 1024
  const CHUNK = 8 * 1024 * 1024
  // Under the bench's own tmp (a real path, as phase 7's zip-tree), so main's finally and the next run
  // remove a leftover; a stale big.bin would pass the size check while the new file took a numbered name.
  const dir = join(tmp, 'upload-tree')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const token = 'bench-token'
  const grant = { token, uploadId: 'bench-upload-0000', deviceId: 'bench', windowId: 1, index: 0, folderReal: dir, folderRel: '', name: 'big.bin', choice: 'new', size: TOTAL }
  let outcome
  const writer = new lib.UploadWriter({
    grants: () => ({
      grant: (t) => (t === token && !outcome ? grant : undefined),
      touch() {},
      settle(_t, o) {
        outcome = o
      }
    }),
    projectRoot: () => dir,
    tempsFile: join(tmp, 'upload-temps.json'),
    log: (m) => console.log(m)
  })
  const server = createServer(async (req, res) => {
    const offset = Number(req.headers['x-offset'])
    const r = await writer.writeChunk(token, offset, req, Number(req.headers['content-length']))
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(r))
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  const port = server.address().port
  const agent = new Agent({ keepAlive: true, maxSockets: 1 })
  const body = Buffer.alloc(CHUNK)
  for (let at = 0; at < CHUNK / 2; ) at += body.write(text.slice(0, CHUNK / 2 - at), at, 'latin1')
  for (let i = CHUNK / 2; i < CHUNK; i++) body[i] = Math.floor(rand() * 256)
  const put = (offset) =>
    new Promise((ok, fail) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'PUT', agent, headers: { 'content-length': CHUNK, 'x-offset': offset } }, (res) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (out += d))
        res.on('end', () => (res.statusCode === 200 ? ok(JSON.parse(out)) : fail(new Error(`PUT at ${offset}: ${res.statusCode} ${out}`))))
      })
      req.on('error', fail)
      req.end(body)
    })
  let done = false
  let sent = 0
  const t0 = performance.now()
  let uploadEnd = t0
  const upload = (async () => {
    try {
      for (let off = 0; off < TOTAL; off += CHUNK) {
        await put(off)
        sent += CHUNK
      }
    } finally {
      uploadEnd = performance.now()
      done = true
    }
  })()
  const count = { posted: 0 }
  let r
  try {
    // 0 s: the window ends with the upload (see the header comment), never at SECONDS.
    r = await measure(0, () => floodTick(count), () => done)
    await upload
    const seconds = (uploadEnd - t0) / 1000
    const size = statSync(join(dir, 'big.bin')).size
    if (!outcome?.ok || size !== TOTAL) throw new Error(`9. upload: ${mib(size)} MiB at big.bin, outcome ${JSON.stringify(outcome)}: not the 1 GiB upload`)
    console.log(`\n9. upload + flooded: ${mib(sent)} MiB in ${sent / CHUNK} PUTs of ${mib(CHUNK)} MiB in ${seconds.toFixed(1)} s = ${(sent / 1024 / 1024 / seconds).toFixed(0)} MiB/s; ${mib(count.posted)} MiB parsed meanwhile`)
    console.log(`   ${line(r)}`)
  } finally {
    agent.destroy()
    await new Promise((ok) => server.close(ok))
    // Flush the temps record first: its debounced save would re-create the deleted folder's parent later.
    await writer.sweepTemps()
    rmSync(dir, { recursive: true, force: true })
  }
  return r
}

/** Phase 5 at one page size: the flood with the page streaming to one viewer. */
async function streamed(lib, width, height) {
  const { FrameStream, WebviewViewers, FRAME_DRAINED_BYTES } = lib
  const panel = { windowId: 1, pluginId: 'bench.browser', panelId: 'browser' }
  const viewer = 'web:1'
  const socket = new FakeSocket()
  const viewers = new WebviewViewers({ setViewed: () => undefined, setSize: () => undefined, log: (m) => console.log(m) })
  const stream = new FrameStream({
    viewers,
    sendFrame: (viewId, frame) => viewId === viewer && socket.send(frame),
    drained: (viewId) => viewId === viewer && socket.bufferedAmount() <= FRAME_DRAINED_BYTES,
    now: () => performance.now(),
    log: (m) => console.log(m)
  })
  // The off-screen page as the server makes it (electron-offscreen-webview.ts): the same switches,
  // offscreen, dialogs off, 30 fps.
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, disableDialogs: true, sandbox: true, contextIsolation: true }
  })
  win.setContentSize(width, height)
  win.webContents.setFrameRate(30)
  const cost = { paints: 0, encodes: 0, encodeMs: 0, maxMs: 0 }
  // Timed: the stream's encode (resize and toJPEG) is what runs on main per frame.
  const timed = (img) => ({
    isEmpty: () => img.isEmpty(),
    getSize: () => img.getSize(),
    resize: (o) => {
      const t0 = performance.now()
      const out = img.resize(o)
      const dt = performance.now() - t0
      cost.encodeMs += dt
      cost.maxMs = Math.max(cost.maxMs, dt)
      return timed(out)
    },
    toJPEG: (q) => {
      const t0 = performance.now()
      const out = img.toJPEG(q)
      const dt = performance.now() - t0
      cost.encodes++
      cost.encodeMs += dt
      cost.maxMs = Math.max(cost.maxMs, dt)
      return out
    }
  })
  const detach = stream.attach(panel, { invalidate: () => win.webContents.invalidate() })
  win.webContents.on('paint', (_event, _dirty, image) => {
    cost.paints++
    stream.paint(panel, timed(image))
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ANIMATED_PAGE))
  viewers.report(panel, viewer, { width, height, visible: true, hidden: false })
  // Let it reach its pace before measuring.
  await new Promise((r) => setTimeout(r, 500))
  Object.assign(cost, { paints: 0, encodes: 0, encodeMs: 0, maxMs: 0 })
  socket.frames = 0
  socket.bytes = 0
  const count = { posted: 0 }
  const r = await measure(SECONDS, () => floodTick(count))
  const seconds = SECONDS + r.drainedMs / 1000
  viewers.viewGone(viewer)
  detach()
  stream.dispose()
  win.destroy()
  console.log(
    `\n5. streamed webview ${width}x${height} + flooded: ${mib(count.posted)} MiB parsed, ${(cost.paints / seconds).toFixed(0)} paints/s, ` +
      `${(socket.frames / seconds).toFixed(0)} frames/s sent (${(socket.bytes / Math.max(1, socket.frames) / 1024).toFixed(0)} KiB each, viewer at ${mib(VIEWER_RATE)} MiB/s)`
  )
  console.log(
    `   encode ${(cost.encodeMs / Math.max(1, cost.encodes)).toFixed(1)} ms avg, ${cost.maxMs.toFixed(1)} ms max, ${((cost.encodeMs / (seconds * 1000)) * 100).toFixed(0)}% of main`
  )
  console.log(`   ${line(r)}`)
  return r
}

/** Phase 8: `n` animated pages (one viewer each) with the flood beside them, with or without the budget. */
async function streamedMany(lib, n, width, height, budgeted) {
  const { FrameStream, WebviewViewers, FRAME_DRAINED_BYTES, FrameBudget } = lib
  const sockets = new Map()
  const viewers = new WebviewViewers({ setViewed: () => undefined, setSize: () => undefined, log: (m) => console.log(m) })
  const stream = new FrameStream({
    viewers,
    sendFrame: (viewId, frame) => sockets.get(viewId)?.send(frame),
    drained: (viewId) => (sockets.get(viewId)?.bufferedAmount() ?? 0) <= FRAME_DRAINED_BYTES,
    now: () => performance.now(),
    log: (m) => console.log(m)
  })
  const budget = budgeted ? new FrameBudget(() => performance.now()) : undefined
  const cost = { paints: 0, encodes: 0, encodeMs: 0 }
  const timed = (img) => ({
    isEmpty: () => img.isEmpty(),
    getSize: () => img.getSize(),
    resize: (o) => {
      const t0 = performance.now()
      const out = img.resize(o)
      cost.encodeMs += performance.now() - t0
      return timed(out)
    },
    toJPEG: (q) => {
      const t0 = performance.now()
      const out = img.toJPEG(q)
      cost.encodes++
      cost.encodeMs += performance.now() - t0
      return out
    }
  })
  const pages = []
  const gone = []
  const perPage = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    const panel = { windowId: 1, pluginId: 'bench.browser', panelId: 'browser' + i }
    const viewer = 'web:' + i
    sockets.set(viewer, new FakeSocket())
    const win = new BrowserWindow({ show: false, width, height, useContentSize: true, frame: false, webPreferences: { offscreen: true, disableDialogs: true, sandbox: true, contextIsolation: true } })
    win.setContentSize(width, height)
    win.webContents.setFrameRate(30)
    const detach = stream.attach(panel, { invalidate: () => win.webContents.invalidate() })
    budget?.add('p' + i, { setRate: (r) => win.webContents.setFrameRate(r) }, width, height)
    budget?.setViewed('p' + i, true)
    win.webContents.on('paint', (_e, _d, image) => {
      cost.paints++
      perPage[i]++
      budget?.paint('p' + i)
      stream.paint(panel, timed(image))
    })
    win.webContents.on('render-process-gone', (_e, d) => gone.push(`page ${i}: ${d.reason}`))
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ANIMATED_PAGE))
    viewers.report(panel, viewer, { width, height, visible: true, hidden: false })
    pages.push({ win, detach, viewer })
  }
  const timer = budget ? setInterval(() => budget.evaluate(), 250) : undefined
  // The budget needs a second of paints to see the pages animate, then a moment to settle.
  await new Promise((r) => setTimeout(r, budgeted ? 2500 : 500))
  Object.assign(cost, { paints: 0, encodes: 0, encodeMs: 0 })
  perPage.fill(0)
  for (const s of sockets.values()) {
    s.frames = 0
    s.bytes = 0
  }
  const count = { posted: 0 }
  const r = await measure(SECONDS, () => floodTick(count))
  const seconds = SECONDS + r.drainedMs / 1000
  let frames = 0
  let bytes = 0
  for (const s of sockets.values()) {
    frames += s.frames
    bytes += s.bytes
  }
  if (timer) clearInterval(timer)
  for (const p of pages) {
    viewers.viewGone(p.viewer)
    p.detach()
    p.win.destroy()
  }
  stream.dispose()
  const minPaints = Math.min(...perPage)
  const res = { ...r, n, size: `${width}x${height}`, budgeted, gone, minPaints, needPaints: Math.floor(5 * SECONDS) }
  console.log(
    `\n8. ${n} streamed ${res.size} webviews${budgeted ? ' under the budget' : ''} + flooded: ${(cost.paints / seconds).toFixed(0)} paints/s, ${(frames / seconds).toFixed(0)} frames/s encoded and sent, ` +
      `${mib(bytes / seconds)} MiB/s; encode ${((cost.encodeMs / (seconds * 1000)) * 100).toFixed(0)}% of main`
  )
  console.log(`   ${line(r)}`)
  console.log(`   paints per page over ${seconds.toFixed(1)} s: ${perPage.join(' ')}${gone.length ? '; renderer gone: ' + gone.join(', ') : ''}`)
  return res
}

async function main() {
  // --- the real mirror and worker, the real frame stream ------------------------------------------
  // Under node_modules so the bundles' require('@xterm/...') resolves from the repo.
  // Its real path: in a worktree node_modules is a link, and phase 7's zip refuses a path with a link above it.
  const tmp0 = join(root, 'node_modules', '.cache', 'web-terminal-bench')
  mkdirSync(tmp0, { recursive: true })
  const tmp = realpathSync(tmp0)
  await bundle(tmp, 'mirror.cjs', 'src/main/terminals/mirror.ts')
  await bundle(tmp, 'mirror-worker.js', 'src/main/terminals/mirror-worker.ts')
  await bundle(tmp, 'frames.cjs', {
    contents: [
      "export { FrameStream } from './src/main/webview/frame-stream'",
      "export { WebviewViewers } from './src/main/webview/webview-viewers'",
      "export { FrameBudget, BUDGET_AREA_RATE } from './src/main/webview/frame-budget'",
      "export { FRAME_DRAINED_BYTES } from './src/shared/web-protocol'"
    ].join('\n')
  })
  await bundle(tmp, 'zip.cjs', "src/main/files/zip-writer.ts")
  const zipLib = createRequire(join(tmp, 'zip.cjs'))(join(tmp, 'zip.cjs'))
  await bundle(tmp, 'upload.cjs', "src/main/files/upload-writer.ts")
  const uploadLib = createRequire(join(tmp, 'upload.cjs'))(join(tmp, 'upload.cjs'))
  const { TerminalMirror, nodeMirrorWorker } = createRequire(join(tmp, 'mirror.cjs'))(join(tmp, 'mirror.cjs'))
  const frames = createRequire(join(tmp, 'frames.cjs'))(join(tmp, 'frames.cjs'))

  console.log(`web terminal bench: ${TABS} tabs, ${COLS}x${ROWS}, scrollback 5000, worker thread, ${SECONDS} s per phase, Electron ${process.versions.electron}`)
  if (!globalThis.gc) console.log('(run with --expose-gc for meaningful memory numbers)')
  gc()
  const rssBefore = process.memoryUsage().rss

  mirror = new TerminalMirror({ createWorker: nodeMirrorWorker(join(tmp, 'mirror-worker.js')), log: (m) => console.log(m) })
  mirror.start()
  ids = Array.from({ length: TABS }, (_, i) => `tab${i}`)
  for (const id of ids) mirror.spawned(id, COLS, ROWS)

  let flood, streams, joins, zipRun, uploadRun, many
  try {
    // 1. flooded
    const count = { posted: 0 }
    flood = await measure(SECONDS, () => floodTick(count))
    console.log(`\n1. flooded: ${mib(count.posted)} MiB parsed in ${(SECONDS + flood.drainedMs / 1000).toFixed(1)} s = ${(count.posted / 1024 / 1024 / (SECONDS + flood.drainedMs / 1000)).toFixed(1)} MiB/s total`)
    console.log(`   ${line(flood)}`)

    // 2. paced: a busy Claude streams maybe 20-100 KB/s.
    for (const rate of [64 * 1024, 512 * 1024]) {
      const perTick = Math.max(1, Math.round((rate * FLUSH_MS) / 1000))
      const r = await measure(Math.min(SECONDS, 3), () => {
        for (const id of ids) mirror.data(id, next(id, perTick))
      })
      console.log(`\n2. paced ${(rate / 1024).toFixed(0)} KiB/s per tab: ${line(r)}`)
    }

    // 3. snapshot (scrollback is full after phase 1)
    {
      const h = monitorEventLoopDelay({ resolution: 1 })
      h.enable()
      const t0 = performance.now()
      const states = await Promise.all(ids.map((id) => mirror.inspect(id)))
      const dt = performance.now() - t0
      h.disable()
      const size = Math.max(...states.map((s) => s?.data.length ?? 0))
      console.log(`\n3. snapshot: ${TABS} inspects in ${dt.toFixed(0)} ms, ${(size / 1024).toFixed(0)} KiB (UTF-16 units) max; main's delay meanwhile p99 ${ms(h.percentile(99))} ms, max ${ms(h.max)} ms`)
    }

    // 4. memory
    gc()
    console.log(`\n4. memory: RSS +${mib(process.memoryUsage().rss - rssBefore)} MiB for ${TABS} tabs (main and worker)`)

    // 5. streamed webview, at a laptop browser's size and at the encode area cap
    streams = []
    for (const [w, h] of [[1280, 800], [1920, 1080]]) streams.push({ size: `${w}x${h}`, r: await streamed(frames, w, h) })

    // 6. a group of 4 busy tabs joined at once (needs at least 4 tabs; the flood above filled their scrollback)
    joins = ids.length >= 4 ? [await groupJoin(false), await groupJoin(true)] : []

    // 7. a 1 GiB zip streaming beside the flooded tabs
    zipRun = await zipDownload(zipLib, tmp)

    // 8. N animated pages at once
    many = []
    if (SWEEP) for (const [w, h] of [[1280, 800], [1920, 1080]]) for (const n of [1, 4, 8, 12]) await streamedMany(frames, n, w, h, false)
    many.push(await streamedMany(frames, 12, 1920, 1080, true))

    // 9. a 1 GiB upload through the real writer beside the flooded tabs
    uploadRun = await uploadPhase(uploadLib, tmp)

  } finally {
    mirror.stop()
    rmSync(tmp, { recursive: true, force: true })
  }
  let ok = flood.p99 / 1e6 <= P99_LIMIT_MS
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: flooded p99 ${ms(flood.p99)} ms ${ok ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
  for (const { size, r } of streams) {
    const pass = r.p99 / 1e6 <= P99_LIMIT_MS
    ok &&= pass
    console.log(`${pass ? 'PASS' : 'FAIL'}: flooded with a streamed ${size} webview p99 ${ms(r.p99)} ms ${pass ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
  }
  for (const [i, j] of joins.entries()) {
    const label = i === 0 ? 'all at once' : 'staged'
    const pass = j.p99 / 1e6 <= P99_LIMIT_MS && j.peak <= j.limit
    ok &&= pass
    console.log(`${pass ? 'PASS' : 'FAIL'}: group join ${label}: p99 ${ms(j.p99)} ms, peak unsent ${mib(j.peak)} MiB, last snapshot ${j.lastMs.toFixed(0)} ms`)
  }
  {
    const pass = zipRun.p99 / 1e6 <= P99_LIMIT_MS
    ok &&= pass
    console.log(`${pass ? 'PASS' : 'FAIL'}: flooded with a 1 GiB zip download p99 ${ms(zipRun.p99)} ms ${pass ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
  }
  {
    const pass = uploadRun.p99 / 1e6 <= P99_LIMIT_MS
    ok &&= pass
    console.log(`${pass ? 'PASS' : 'FAIL'}: flooded with a 1 GiB upload p99 ${ms(uploadRun.p99)} ms ${pass ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
  }
  for (const r of many) {
    // A crashed or stalled page must not pass by leaving only the flood to measure: every page needs
    // the budget floor's 5 fps over the window and no renderer may have gone.
    const pass = r.p99 / 1e6 <= P99_LIMIT_MS && r.gone.length === 0 && r.minPaints >= r.needPaints
    ok &&= pass
    console.log(`${pass ? 'PASS' : 'FAIL'}: flooded with ${r.n} streamed ${r.size} webviews under the budget p99 ${ms(r.p99)} ms ${pass ? '<=' : '>'} ${P99_LIMIT_MS} ms, min ${r.minPaints} paints per page (need ${r.needPaints}), ${r.gone.length} renderers gone`)
  }
  return ok ? 0 : 1
}

// No window of ours must quit the app between phases; the result is the exit status.
app.on('window-all-closed', () => {})
app
  .whenReady()
  .then(main)
  .then(
    (code) => app.exit(code),
    (err) => {
      console.error(err)
      app.exit(1)
    }
  )
