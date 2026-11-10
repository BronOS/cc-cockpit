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
// Exits 1 when phase 1's p99 delay is over the limit, so a change that puts parsing back on main
// fails the bench.
import { build } from 'esbuild'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TABS = Number(process.argv[2] ?? 8)
const SECONDS = Number(process.argv[3] ?? 5)
const P99_LIMIT_MS = Number(process.argv[4] ?? 20)
const COLS = 120
const ROWS = 40
const FLUSH_MS = 8
const FLUSH_BYTES = 64 * 1024
const HIGH_WATER = 1024 * 1024

// --- the real mirror and worker ------------------------------------------------------------------
// Under node_modules so the bundles' require('@xterm/...') resolves from the repo.
const tmp = join(root, 'node_modules', '.cache', 'web-terminal-bench')
mkdirSync(tmp, { recursive: true })
for (const [name, entry] of [
  ['mirror.cjs', 'src/main/terminals/mirror.ts'],
  ['mirror-worker.js', 'src/main/terminals/mirror-worker.ts']
]) {
  const out = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: ['@xterm/*'],
    logLevel: 'warning'
  })
  writeFileSync(join(tmp, name), out.outputFiles[0].text)
}
const { TerminalMirror, nodeMirrorWorker } = createRequire(join(tmp, 'mirror.cjs'))(join(tmp, 'mirror.cjs'))

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

/** Run `tick` every FLUSH_MS for `seconds`, then wait for the worker; main's delay meanwhile. */
async function measure(seconds, tick) {
  const h = monitorEventLoopDelay({ resolution: 1 })
  h.enable()
  const elu = performance.eventLoopUtilization()
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
    utilization: performance.eventLoopUtilization(elu).utilization,
    drainedMs: Math.max(0, performance.now() - t0 - seconds * 1000)
  }
}
const line = (r) =>
  `event-loop delay p50 ${ms(r.p50)} ms, p99 ${ms(r.p99)} ms, max ${ms(r.max)} ms; utilization ${(r.utilization * 100).toFixed(0)}%; worker done ${r.drainedMs.toFixed(0)} ms after the last chunk`

console.log(`web terminal bench: ${TABS} tabs, ${COLS}x${ROWS}, scrollback 5000, worker thread, ${SECONDS} s per phase`)
if (!globalThis.gc) console.log('(run with --expose-gc for meaningful memory numbers)')
gc()
const rssBefore = process.memoryUsage().rss

const mirror = new TerminalMirror({ createWorker: nodeMirrorWorker(join(tmp, 'mirror-worker.js')), log: (m) => console.log(m) })
mirror.start()
const ids = Array.from({ length: TABS }, (_, i) => `tab${i}`)
for (const id of ids) mirror.spawned(id, COLS, ROWS)

// 1. flooded
let posted = 0
const flood = await measure(SECONDS, () => {
  for (const id of ids) {
    if (mirror.backlog(id) > HIGH_WATER) continue
    mirror.data(id, next(id, FLUSH_BYTES))
    posted += FLUSH_BYTES
  }
})
console.log(`\n1. flooded: ${mib(posted)} MiB parsed in ${(SECONDS + flood.drainedMs / 1000).toFixed(1)} s = ${(posted / 1024 / 1024 / (SECONDS + flood.drainedMs / 1000)).toFixed(1)} MiB/s total`)
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

mirror.stop()
rmSync(tmp, { recursive: true, force: true })
const ok = flood.p99 / 1e6 <= P99_LIMIT_MS
console.log(`\n${ok ? 'PASS' : 'FAIL'}: flooded p99 ${ms(flood.p99)} ms ${ok ? '<=' : '>'} ${P99_LIMIT_MS} ms`)
process.exit(ok ? 0 : 1)
