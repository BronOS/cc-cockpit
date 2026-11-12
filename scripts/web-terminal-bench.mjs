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
// Exits 1 when phase 1's or phase 5's p99 delay is over the limit, so a change that puts parsing back
// on main, or lets frames take main from the terminals, fails the bench.
//
// It runs as Electron's main process (the off-screen page needs Electron): started with node, it
// starts itself again under this repo's Electron (on Linux with the server's headless switches,
// `--ozone-platform=headless --disable-gpu`, so no display is needed) and exits with its status.
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
async function measure(seconds, tick) {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const t0 = performance.now()
  await new Promise((done) => {
    const timer = setInterval(() => {
      tick()
      if (performance.now() - t0 > seconds * 1000) {
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
    drainedMs: Math.max(0, performance.now() - t0 - seconds * 1000)
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

async function main() {
  // --- the real mirror and worker, the real frame stream ------------------------------------------
  // Under node_modules so the bundles' require('@xterm/...') resolves from the repo.
  const tmp = join(root, 'node_modules', '.cache', 'web-terminal-bench')
  mkdirSync(tmp, { recursive: true })
  await bundle(tmp, 'mirror.cjs', 'src/main/terminals/mirror.ts')
  await bundle(tmp, 'mirror-worker.js', 'src/main/terminals/mirror-worker.ts')
  await bundle(tmp, 'frames.cjs', {
    contents: [
      "export { FrameStream } from './src/main/webview/frame-stream'",
      "export { WebviewViewers } from './src/main/webview/webview-viewers'",
      "export { FRAME_DRAINED_BYTES } from './src/shared/web-protocol'"
    ].join('\n')
  })
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

  // 1. flooded
  const count = { posted: 0 }
  const flood = await measure(SECONDS, () => floodTick(count))
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
  const streams = []
  for (const [w, h] of [[1280, 800], [1920, 1080]]) streams.push({ size: `${w}x${h}`, r: await streamed(frames, w, h) })

  mirror.stop()
  rmSync(tmp, { recursive: true, force: true })
  let ok = flood.p99 / 1e6 <= P99_LIMIT_MS
  console.log(`\n${ok ? 'PASS' : 'FAIL'}: flooded p99 ${ms(flood.p99)} ms ${ok ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
  for (const { size, r } of streams) {
    const pass = r.p99 / 1e6 <= P99_LIMIT_MS
    ok &&= pass
    console.log(`${pass ? 'PASS' : 'FAIL'}: flooded with a streamed ${size} webview p99 ${ms(r.p99)} ms ${pass ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
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
