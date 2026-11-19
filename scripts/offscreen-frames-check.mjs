// The off-screen cancels (webview-hardening.ts cancelOffscreenNativeUi) in cross-site frames, under
// Electron: a unit test with a fake debugger proves nothing about which frames Chromium's DevTools
// sessions reach. Bundles the real OffscreenWebviewFactory (src/main/webview/electron-offscreen-webview.ts)
// with esbuild, makes a view the way server mode does and loads a page with a cross-site iframe
// that holds another cross-site iframe (127.0.0.1, then localhost, then [::1]: three sites, so
// with site isolation each frame is its own process, which the check verifies). In each of the three
// frames the page's own code, run under a user activation (a trusted click in the top frame, a
// gesture from main in the nested ones; see the loop below), clicks an
// <input type=file>, calls showOpenFilePicker, window.print() and document.execCommand('print').
// Passes (exit 0) when, in every frame: the chooser and the picker were cancelled (the input's
// `cancel` event, the picker's AbortError, both under a user activation), print and
// execCommand('print') returned at once (the frame still answers afterwards) and neither is the
// native function; each nested frame was auto-attached as an `iframe` target; and main is alive at
// the end. Same-origin about:blank and srcdoc frames are reported too (a page reaching a fresh
// realm's print).
//
//   node scripts/offscreen-frames-check.mjs                     the worktree's webview-hardening.ts
//   node scripts/offscreen-frames-check.mjs --hardening <file>  another version of it in its place (a
//                                                               control run against an older one; it
//                                                               may open real dialogs and is killed
//                                                               after 30 s)
//
// On Linux it runs with the server's headless switches but keeps the session bus, so a desktop
// portal there (the case the cancels exist for) is what a missed cancel would reach; on a Mac a
// missed chooser or print opens the native panel instead.
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const self = fileURLToPath(import.meta.url)
const KILL_AFTER_MS = 30_000

// --- the launcher (plain node) -------------------------------------------------------------------
if (!process.versions.electron) {
  const at = process.argv.indexOf('--hardening')
  const hardening = at === -1 ? undefined : resolve(process.argv[at + 1] ?? '')
  const electronPath = createRequire(import.meta.url)('electron')
  const switches = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []
  const env = { ...process.env, CC_FRAMES_CHECK_HARDENING: hardening ?? '' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...switches, self], { stdio: 'inherit', env })
  // A dialog a missed cancel opened can hold Electron's main (a modal run loop): kill from here.
  const killer = setTimeout(() => {
    console.error(`FAIL: still running after ${KILL_AFTER_MS} ms (a dialog holding main or a frame?), killed`)
    child.kill('SIGKILL')
  }, KILL_AFTER_MS)
  const code = await new Promise((done) => child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0))))
  clearTimeout(killer)
  process.exit(code)
}

// --- under Electron ------------------------------------------------------------------------------
const { app, BrowserWindow, webContents } = createRequire(import.meta.url)('electron')

/** The real factory, bundled; `--hardening` swaps in another webview-hardening.ts. */
async function loadFactory() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-frames-check-'))
  const swap = process.env.CC_FRAMES_CHECK_HARDENING
  const out = join(dir, 'factory.cjs')
  await build({
    stdin: { contents: "export { OffscreenWebviewFactory } from './src/main/webview/electron-offscreen-webview'", resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    external: ['electron'],
    logLevel: 'error',
    plugins: swap
      ? [{ name: 'swap', setup: (b) => b.onResolve({ filter: /^\.\/webview-hardening$/ }, () => ({ path: swap })) }]
      : []
  })
  const mod = createRequire(import.meta.url)(out)
  rmSync(dir, { recursive: true, force: true })
  return mod.OffscreenWebviewFactory
}

/** One page for every frame; its role comes from the host it was loaded from. */
function page(port) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;width:100%;height:100%} iframe{position:absolute;border:0} #f{position:absolute;left:0;top:0;width:60px}</style>
<input type="file" id="f">
<script>
  window.__log = []
  const note = (what, extra) => void __log.push({ what, active: navigator.userActivation.isActive, ...extra })
  const isNative = (fn) => typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]')
  note('loaded', { printNative: isNative(window.print), execNative: isNative(Document.prototype.execCommand) })
  const f = document.getElementById('f')
  f.addEventListener('cancel', () => note('input-cancel'))
  f.addEventListener('change', () => note('input-change'))
  // Fresh same-origin realms: are they locked too? Only looked at, never called.
  for (const kind of ['blank', 'srcdoc']) {
    const fr = document.createElement('iframe')
    fr.style.cssText = 'left:-500px;top:0;width:10px;height:10px'
    if (kind === 'srcdoc') fr.srcdoc = '<p>x</p>'
    document.body.append(fr)
    const look = () => note(kind, { printNative: isNative(fr.contentWindow.print), execNative: isNative(fr.contentWindow.Document.prototype.execCommand) })
    if (kind === 'blank') look()
    else fr.addEventListener('load', look)
  }
  const host = location.hostname
  const next = host === '127.0.0.1' ? 'localhost' : host === 'localhost' ? '[::1]' : undefined
  if (next) {
    const fr = document.createElement('iframe')
    fr.src = 'http://' + next + ':${port}/'
    fr.style.cssText = host === '127.0.0.1' ? 'left:0;top:100px;width:800px;height:500px' : 'left:400px;top:100px;width:300px;height:300px'
    document.body.append(fr)
  }
  const steps = [
    () => { note('input-click'); f.click() },
    () => {
      note('picker')
      showOpenFilePicker().then(() => note('picker-resolved'), (e) => note('picker-rejected', { name: e.name, message: e.message }))
    },
    () => { note('print'); window.print(); note('print-returned') },
    () => {
      note('exec-print')
      note('exec-print-returned', { result: document.execCommand('print') })
      note('exec-print-mixed', { result: document.execCommand('PrInT') })
    }
  ]
  let step = 0
  window.__step = () => steps[step++]?.()
  document.addEventListener('click', (e) => {
    if (e.target !== f) __step()
  })
</script>`
}

/** Where the trusted click lands in the top frame (CSS px), clear of the input and the nested frame. */
const CLICK_TOP = { x: 1000, y: 50 }
const ROLE = { '127.0.0.1': 'top', localhost: 'child', '[::1]': 'grand' }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)])

async function main() {
  const OffscreenWebviewFactory = await loadFactory()
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(page(server.address().port))
  })
  // Dual stack: localhost may resolve to ::1, and [::1] is the third site.
  await new Promise((done) => server.listen(0, '::', done))
  const port = server.address().port

  const owner = new BrowserWindow({ show: false })
  const logs = []
  const factory = new OffscreenWebviewFactory(async () => new Response('', { status: 404 }), (m) => void logs.push(m))
  const view = factory.create(owner.id, 'webview-frames-check', {
    allowNavigation: () => true,
    openWindow: () => {},
    navigated: () => {},
    loadFailed: (url, error) => logs.push(`load failed ${url} ${error}`),
    chord: () => false,
    gone: () => logs.push('gone')
  })
  const wc = webContents.getAllWebContents().find((w) => w.isOffscreen())
  const protocol = []
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      protocol.push({ method, type: params.targetInfo.type, url: params.targetInfo.url, waiting: params.waitingForDebugger, session: params.sessionId, parent: sessionId || 'page' })
    } else if (method === 'Page.fileChooserOpened') {
      protocol.push({ method, session: sessionId || 'page', mode: params.mode })
    }
  })
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
  view.setVisible(true)
  await view.load(`http://127.0.0.1:${port}/`)

  const frames = async () => {
    const byRole = {}
    for (const fr of wc.mainFrame.framesInSubtree) {
      const role = ROLE[new URL(fr.url || 'about:blank').host.replace(`:${port}`, '')]
      if (role && fr.url.endsWith(`:${port}/`)) byRole[role] = fr
    }
    return byRole
  }
  const read = async (fr) => within(fr.executeJavaScript('JSON.stringify(window.__log)').then(JSON.parse, () => 'gone'), 3000, 'unresponsive')
  // All three loaded (each logs `loaded` first).
  let found = {}
  for (let i = 0; i < 50; i++) {
    found = await frames()
    if (Object.keys(found).length === 3 && (await Promise.all(Object.values(found).map(read))).every((l) => Array.isArray(l) && l.length > 0)) break
    await sleep(100)
  }
  const failures = []
  if (Object.keys(found).length !== 3) failures.push(`frames found: ${Object.keys(found).join(', ') || 'none'}`)
  const pids = Object.fromEntries(Object.entries(found).map(([r, fr]) => [r, fr.osProcessId]))
  console.log('frame processes:', JSON.stringify(pids))
  if (new Set(Object.values(pids)).size !== Object.keys(pids).length) failures.push('the frames do not each have their own process (no site isolation?)')

  // Each frame's log after every step, the last readable one kept: a frame a dialog blocked stops
  // answering, and what it logged before still says which step did it.
  const results = {}
  const stalled = {}
  const STEPS = ['input-click', 'picker', 'print', 'exec-print']
  for (let step = 0; step < STEPS.length; step++) {
    // The top frame by a trusted click. The off-screen view does not route sendInputEvent into an
    // out-of-process frame (the top document gets it, its target the IFRAME element), so a nested
    // frame's step runs from main with a user gesture: the same activation a click there gives.
    const { x, y } = CLICK_TOP
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    for (const role of ['child', 'grand']) void found[role]?.executeJavaScript('__step()', true).catch(() => {})
    await sleep(1500)
    for (const [role, fr] of Object.entries(found)) {
      if (stalled[role]) continue
      const log = await read(fr)
      if (Array.isArray(log)) results[role] = log
      else stalled[role] = `${log} after the ${STEPS[step]} step`
    }
  }
  for (const role of ['top', 'child', 'grand']) {
    const log = results[role]
    console.log(`\n${role} (${found[role]?.url}):`)
    if (stalled[role]) failures.push(`${role}: ${stalled[role]}`)
    if (!Array.isArray(log)) {
      failures.push(`${role}: no log`)
      continue
    }
    for (const entry of log) console.log('  ' + JSON.stringify(entry))
    if (stalled[role]) console.log(`  (${stalled[role]})`)
    const get = (what) => log.find((e) => e.what === what)
    const want = (ok, text) => ok || failures.push(`${role}: ${text}`)
    want(get('loaded')?.printNative === false, 'window.print is the native one')
    want(get('loaded')?.execNative === false, 'execCommand is the native one')
    want(get('input-click')?.active === true, 'the input click had no user activation (the check proves nothing)')
    want(get('input-cancel') !== undefined, 'the file input was not cancelled')
    want(get('picker')?.active === true, 'the picker call had no user activation (the check proves nothing)')
    // Chromium refuses the File System Access pickers in a cross-origin sub-frame outright
    // (SecurityError, before any chooser): there only the top frame's AbortError proves the cancel.
    const picked = get('picker-rejected')
    const refusedHere = role !== 'top' && picked?.name === 'SecurityError' && /Cross origin sub frames/.test(picked.message)
    want(picked?.name === 'AbortError' || refusedHere, `the picker was not aborted (${JSON.stringify(get('picker-rejected') ?? get('picker-resolved') ?? 'pending')})`)
    want(get('print-returned') !== undefined, 'print() did not return')
    want(get('exec-print-returned')?.result === false && get('exec-print-mixed')?.result === false, "execCommand('print') was not refused")
  }
  console.log('\nprotocol:')
  for (const p of protocol) console.log('  ' + JSON.stringify(p))
  // The child is attached from the page's session, the grandchild from the child's (the url is
  // still empty then: attached paused, before its first document).
  const attached = protocol.filter((p) => p.method === 'Target.attachedToTarget' && p.type === 'iframe')
  const childAttach = attached.find((p) => p.parent === 'page')
  if (!childAttach) failures.push('child: never auto-attached as an iframe target')
  if (!attached.some((p) => childAttach && p.parent === childAttach.session)) failures.push("grand: never auto-attached (from the child's session) as an iframe target")
  if (attached.some((p) => !p.waiting)) failures.push('a frame was attached without waiting for its cancels')
  console.log('\nlog:', JSON.stringify(logs))
  // Main is alive (we got here) and the page still answers.
  const alive = await within(wc.mainFrame.executeJavaScript('1 + 1'), 3000, 'unresponsive')
  console.log('top frame answers after all:', alive)
  if (alive !== 2) failures.push('the top frame no longer answers')
  view.destroy()
  owner.destroy()
  server.close()
  if (failures.length) {
    console.log('\nFAIL:\n  ' + failures.join('\n  '))
    return 1
  }
  console.log('\nOK: choosers and pickers cancelled, print and execCommand(print) refused in every cross-site frame; main alive')
  return 0
}

app.whenReady().then(main).then(
  (code) => app.exit(code),
  (err) => {
    console.error(err)
    app.exit(1)
  }
)
