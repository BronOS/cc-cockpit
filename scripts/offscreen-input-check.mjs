// A browser's input into a streamed (off-screen) page, under Electron: a unit test with a fake view
// proves nothing about Chromium's input routing. Bundles the real OffscreenWebviewFactory
// (src/main/webview/electron-offscreen-webview.ts, with its PageInputRouter, page-input.ts) and
// WebviewInput (webview-input.ts) with esbuild, makes a view the way server mode does (its page
// protocol attached and auto-attaching frames, webview-hardening.ts), and loads a top page on
// 127.0.0.1 (scrollable) holding a cross-site iframe on localhost (A, scrollable) that holds another
// on [::1] (B), a second localhost iframe at scale(0.5) (T), a same-origin iframe (S) and a same-origin
// one (W, scrollable) holding a localhost iframe (X): three sites, each cross-site frame its own
// process with site isolation, S and W in the top's (checked). Below the top's fold: a same-origin P
// with an uneven border and padding, a same-origin U at scale(0.5), O on 127.0.0.1 at a second port
// (same-site, cross-origin), a sandboxed D (allow-scripts) and a localhost N; below A's fold a
// same-origin Q in A. Each document logs the trusted events it gets.
//
// Roads, each into the top document and A:
//   raw       `webContents.sendInputEvent`;
//   protocol  `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` on the
//             page's own DevTools session (no sessionId);
//   child     the same commands on A's own session (auto-attached), in its coordinates;
//   view      what main does: WebviewInput.accept / acceptText (the lane, edit chords) into the
//             view's router (keys on the page's session, pointer events to the frame under the point).
// For each: a click focuses a field, keys and a committed text type into it, Ctrl+A and Cmd+A
// select all, a drag selects, a wheel scrolls a box, a pointer over a link gives the hand cursor.
// The raw and protocol roads miss A's pointer events (the reason for the router: the top document
// gets them, its target the IFRAME element); their rows are printed, never failures.
//
// Then through the view road, every one a failure when it misses: the same checks in B and T; a
// double click; a drag that leaves A (the selection follows to the end, A gets the release, the top
// nothing) and one from the top document over A (the top keeps it); hover leaving a frame (mouseout
// there); a scrolled top page and a scrolled A (B under both); S, and X under W scrolled (typing,
// a wheel); a link dragged in the top and in A, then a click and keys (nothing stalls); Tab from the top field into A and
// plain keys, a text and an edit chord landing there; every allow-listed key against the raw road
// (the page's key, code and keyCode, and what it types); a prevented plain key down typing nothing;
// undo, redo, a prevented chord, one undo per group (the top document, as before); the editing
// keys (Backspace, Delete, arrows, Shift/Option/Cmd+arrows, Home, End, Option/Cmd+Backspace); the
// Mac line keys in a textarea with the caret mid-line (Cmd+Left/Right/Up/Down, with Shift,
// Cmd+Backspace) and a Cmd+Shift+Left in A; a `<select>` in the top, A, B and T and in X under W (X
// scrolled), through a second WebviewInput wired for popups (the popup with the select's options over
// it in the top page, the press kept from the document, the focus on the select, a choice setting
// the value and firing input and change there and nowhere else); copy of a double-clicked word and
// of a field's selection in each of those documents, read where the focus is; the same select and
// copy in the same-origin S, P (scrolled; the point and the rectangle through its border and padding)
// and Q in A (main's scripts stepping into a same-origin frame's document from the top's world and
// from A's); cut (the pushed selection, then Delete, as the browser's onCut) in S, Q and A; no popup
// for a select in U (a scaled same-origin frame is refused, its press goes to the page); N navigating
// to another cross-site document while its popup is open (the old popup's choice changes nothing,
// the new document's select works); order: rounds of clicks into A, the top, B and T with
// keys and texts after each, nothing awaited, and the top document's "abc" é Ctrl+A "x" and
// "abc" é "d". Printed, never failures: a select and a selection in O and D (keyboard-only where
// main's scripts do not reach: O's document is unreadable from the isolated world; D's process is
// printed, an isolated sandboxed frame is reached as a cross-site one: copy there on macOS and Linux,
// a select popup on macOS only, 2026-11-20), Ctrl+E and Ctrl+K (a Mac field's Emacs keys, not mapped),
// and the router's cost per pointer event in each document, and per key event (the protocol's own
// answer, fast typing and a held key's repeat through the router; that every key lands is a check).
//
//   node scripts/offscreen-input-check.mjs [rounds]
//
// Exit 0 when every view-road check passes.
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
const KILL_AFTER_MS = 480_000

// --- the launcher (plain node) -------------------------------------------------------------------
if (!process.versions.electron) {
  const electronPath = createRequire(import.meta.url)('electron')
  const switches = process.platform === 'linux' ? ['--ozone-platform=headless', '--disable-gpu'] : []
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(electronPath, [...switches, self, ...process.argv.slice(2)], { stdio: 'inherit', env })
  const killer = setTimeout(() => {
    console.error(`FAIL: still running after ${KILL_AFTER_MS} ms, killed`)
    child.kill('SIGKILL')
  }, KILL_AFTER_MS)
  const code = await new Promise((done) => child.on('exit', (c, signal) => done(c ?? (signal ? 1 : 0))))
  clearTimeout(killer)
  process.exit(code)
}

// --- under Electron ------------------------------------------------------------------------------
const { app, BrowserWindow, webContents } = createRequire(import.meta.url)('electron')
const userData = mkdtempSync(join(tmpdir(), 'cc-input-check-'))
app.setPath('userData', userData)
// As server mode on a Mac (plan 20261119-server-mode-mac, decision 1).
if (process.platform === 'darwin') {
  app.disableHardwareAcceleration()
  app.setActivationPolicy('accessory')
}
const ROUNDS = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 50)

async function loadModules() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-input-check-build-'))
  const out = join(dir, 'modules.cjs')
  await build({
    stdin: {
      contents:
        "export { OffscreenWebviewFactory } from './src/main/webview/electron-offscreen-webview'\n" +
        "export { WebviewInput, toElectronEvents } from './src/main/webview/webview-input'",
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    external: ['electron'],
    logLevel: 'error'
  })
  const mod = createRequire(import.meta.url)(out)
  rmSync(dir, { recursive: true, force: true })
  return mod
}

/**
 * One page for every document, by role: the top holds A, T, S, W and (below the fold, the top
 * scrolled by FOLD for them) P, U, O, D and N; A holds B and (below its own fold) Q. `port2` is a
 * second port of the same server: 127.0.0.1 on it is same-site, cross-origin.
 */
function page(port, role, port2) {
  const frames =
    role === 'top'
      ? `<iframe id="A" src="http://localhost:${port}/?role=frame"></iframe><iframe id="T" src="http://localhost:${port}/?role=xform"></iframe>` +
        `<iframe id="S" src="/?role=same"></iframe><iframe id="W" src="/?role=wrap"></iframe>` +
        `<iframe id="P" src="/?role=pad"></iframe><iframe id="U" src="/?role=sxform"></iframe>` +
        `<iframe id="O" src="http://127.0.0.1:${port2}/?role=xorigin"></iframe><iframe id="D" sandbox="allow-scripts" src="/?role=sandbox"></iframe>` +
        `<iframe id="N" src="http://localhost:${port}/?role=nav"></iframe>`
      : role === 'frame'
        ? `<iframe id="B" src="http://[::1]:${port}/?role=nested"></iframe><iframe id="Q" src="/?role=asame"></iframe>`
        : role === 'wrap'
          ? `<iframe id="X" src="http://localhost:${port}/?role=inner"></iframe>`
          : ''
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0} body{height:3000px} input{position:absolute;left:10px;top:10px;width:200px;height:30px;font:16px monospace}
#box{position:absolute;left:10px;top:50px;width:200px;height:60px;overflow:auto} #box div{height:2000px}
#l{position:absolute;left:250px;top:10px} textarea{position:absolute;left:300px;top:10px;width:250px;height:80px;font:12px monospace;white-space:pre}
iframe{position:absolute;border:0} #A{left:0;top:200px;width:600px;height:300px} #T{left:650px;top:200px;width:300px;height:300px;transform:scale(0.5);transform-origin:0 0}
#B{left:300px;top:100px;width:280px;height:180px} #S{left:650px;top:400px;width:300px;height:110px}
#W{left:0;top:520px;width:600px;height:170px} #X{left:300px;top:40px;width:280px;height:120px}
#P{left:0;top:760px;width:300px;height:200px;border:5px solid #888;border-left-width:3px;padding:6px 4px}
#U{left:350px;top:760px;width:300px;height:340px;transform:scale(0.5);transform-origin:0 0}
#O{left:0;top:1000px;width:300px;height:200px} #D{left:350px;top:1000px;width:300px;height:200px} #N{left:650px;top:760px;width:300px;height:200px}
#Q{left:10px;top:320px;width:280px;height:200px;border:2px solid #888;padding:3px 5px}
#s{position:absolute;left:10px;top:120px;width:150px;height:24px;margin:0;font:14px monospace} #p{position:absolute;left:10px;top:150px;margin:0;font:14px monospace;white-space:nowrap}</style>
<input id="i" autocomplete="off" value=""><div id="box"><div>scroll</div></div><a id="l" href="#x">a link</a><textarea id="t"></textarea>${frames}
<select id="s"><option>one</option><option>two</option><option disabled>three</option><optgroup label="G"><option>four</option></optgroup></select><p id="p">pick ${role} words</p>
<script>
  window.__log = []
  // The spin case: once armed, a press makes the renderer spin forever 30 ms later (after its click answered).
  document.addEventListener('mousedown', () => { if (window.__arm) setTimeout(() => { for (;;) {} }, 30) }, true)
  window.__prevent = false
  window.__preventPlain = ''
  for (const t of ['mousedown', 'mouseup', 'click', 'keydown', 'keypress', 'wheel', 'focusin', 'mouseout']) {
    document.addEventListener(t, (e) => {
      if (!e.isTrusted) return
      if (t === 'keydown' || t === 'keypress') {
        __log.push(t + ':' + (e.target.id || e.target.tagName) + ':' + e.key + (e.metaKey ? '+M' : '') + (e.ctrlKey ? '+C' : '') + (e.shiftKey ? '+S' : '') + (t === 'keydown' ? '|' + e.code + '|' + e.keyCode : '|' + e.charCode))
        if (t === 'keydown' && ((__prevent && (e.metaKey || e.ctrlKey)) || (__preventPlain && e.key === __preventPlain))) e.preventDefault()
        return
      }
      __log.push(t + ':' + (e.target.id || e.target.tagName))
    }, true)
  }
  const i = document.getElementById('i')
  const ta = document.getElementById('t')
  const s = document.getElementById('s')
  // The select's input and change, trusted or not (a choice main makes fires untrusted ones, as the top's always did).
  window.__chg = []
  for (const t of ['input', 'change']) s.addEventListener(t, () => __chg.push(t + ':' + s.value))
  window.__state = () => ({ value: i.value, sel: [i.selectionStart, i.selectionEnd], text: ta.value, tsel: [ta.selectionStart, ta.selectionEnd], active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), scroll: document.getElementById('box').scrollTop, sv: s.value, chg: __chg.splice(0), log: __log.splice(0) })
  window.__reset = () => { i.value = ''; ta.value = ''; s.selectedIndex = 0; __chg.length = 0; getSelection().removeAllRanges(); document.getElementById('box').scrollTop = 0; scrollTo(0, 0); __log.length = 0; __prevent = false; __preventPlain = ''; if (document.activeElement) document.activeElement.blur() }
  window.__caret = (value, start, end) => { i.value = value; i.focus(); i.setSelectionRange(start, end === undefined ? start : end) }
  window.__tcaret = (value, start, end) => { ta.value = value; ta.focus(); ta.setSelectionRange(start, end === undefined ? start : end) }
</script>`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)])

/** Each document's own points (its CSS px): the field, the box, the link, the select, a word of the paragraph (its role). */
const LOCAL = { input: [20, 25], box: [60, 80], link: [260, 18], select: [50, 132], word: [65, 158] }
/** The select's rectangle in each document's own CSS px (#s). */
const SELECT_RECT = { x: 10, y: 120, width: 150, height: 24 }
/** How far the top page is scrolled for the frames below its fold (P, U, O, D, N), and A for Q. */
const FOLD = 700
const A_FOLD = 200
/**
 * Where a document's own point is in the top page's viewport (the top page scrolled by `scroll`, A
 * by `frameScroll`, W by `wrapScroll`, the document itself by `own`). S, W, P and U are same-origin
 * (the top's process), Q same-origin in A (A's process), X in W cross-site, O same-site but
 * cross-origin, D sandboxed, N cross-site (it navigates to nav2, the same box).
 */
function toTop(doc, [x, y], { scroll = 0, frameScroll = 0, wrapScroll = 0, own = 0 } = {}) {
  y -= own
  if (doc === 'top') return [x, y - scroll]
  if (doc === 'pad') return [3 + 4 + x, 760 + 5 + 6 + y - scroll] // its border 3/5 and padding 4/6 (left/top)
  if (doc === 'sxform') return [350 + x / 2, 760 + y / 2 - scroll]
  if (doc === 'xorigin') return [x, 1000 + y - scroll]
  if (doc === 'sandbox') return [350 + x, 1000 + y - scroll]
  if (doc === 'nav' || doc === 'nav2') return [650 + x, 760 + y - scroll]
  if (doc === 'asame') return [10 + 2 + 5 + x, 200 + 320 + 2 + 3 + y - frameScroll - scroll]
  if (doc === 'same') return [650 + x, 400 + y - scroll]
  if (doc === 'inner') return [300 + x, 520 + 40 + y - wrapScroll - scroll]
  if (doc === 'frame') return [x, 200 + y - frameScroll - scroll]
  if (doc === 'nested') return [300 + x, 200 + 100 + y - frameScroll - scroll]
  return [650 + x / 2, 200 + y / 2 - scroll] // xform: scale(0.5) from its top left
}
/** The protocol's modifier bits. */
const BITS = { alt: 1, control: 2, meta: 4, shift: 8 }

async function main() {
  const { OffscreenWebviewFactory, WebviewInput, toElectronEvents } = await loadModules()
  const serve = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(page(server.address().port, new URL(req.url, 'http://x').searchParams.get('role') ?? 'top', server2.address().port))
  }
  const server = createServer(serve)
  const server2 = createServer(serve)
  await new Promise((done) => server.listen(0, '::', done))
  await new Promise((done) => server2.listen(0, '127.0.0.1', done))
  const port = server.address().port

  const owner = new BrowserWindow({ show: false })
  const logs = []
  const factory = new OffscreenWebviewFactory(async () => new Response('', { status: 404 }), (m) => void logs.push(m))
  const view = factory.create(owner.id, 'webview-input-check', {
    allowNavigation: () => true,
    openWindow: () => {},
    navigated: () => {},
    loadFailed: (url, error) => logs.push(`load failed ${url} ${error}`),
    chord: () => false,
    gone: () => logs.push('gone'),
    restarted: () => logs.push('restarted')
  })
  const wc = webContents.getAllWebContents().find((w) => w.isOffscreen())
  const sessions = new Map()
  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') sessions.set(params.targetInfo.targetId, params.sessionId)
  })
  /** The page's last cursor type (each check clears it first). */
  let cursor
  view.setSink({ paint: () => {}, cursor: (type) => (cursor = type) })
  view.setBounds({ x: 0, y: 0, width: 1000, height: 700 })
  view.setVisible(true)
  await view.load(`http://127.0.0.1:${port}/`)

  const docs = {}
  /** Every role the page loads (nav2 comes later, when N navigates). */
  const ROLES = ['top', 'frame', 'nested', 'xform', 'same', 'wrap', 'inner', 'pad', 'sxform', 'xorigin', 'sandbox', 'nav', 'asame']
  let childSession
  for (let i = 0; i < 80; i++) {
    for (const fr of wc.mainFrame.framesInSubtree) {
      const role = new URL(fr.url || 'about:blank').searchParams.get('role')
      if (fr === wc.mainFrame) docs.top = fr
      else if (role) docs[role] = fr
    }
    if (docs.frame && !childSession) {
      const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets')
      const a = targetInfos.find((t) => t.type === 'iframe' && t.url === `http://localhost:${port}/?role=frame`)
      childSession = a && sessions.get(a.targetId)
    }
    if (ROLES.every((r) => docs[r]) && childSession) break
    await sleep(100)
  }
  const failures = []
  // Rows that miss on a Linux server for a known reason (printed, not failed): a Linux Blink has no
  // Alt word bindings, so the Mac's Option word keys do nothing there (backlog
  // streamed-mac-line-edit-keys.md). On darwin the same rows still fail.
  const linuxKeyLimits = []
  if (!ROLES.every((r) => docs[r]) || !childSession) failures.push(`a frame never loaded or was never attached: ${ROLES.filter((r) => !docs[r]).join(', ')}`)
  const pids = Object.fromEntries(Object.entries(docs).map(([k, f]) => [k, f.osProcessId]))
  if (new Set([pids.top, pids.frame, pids.nested]).size !== 3 || pids.xform === pids.top || pids.inner === pids.top) failures.push(`the frames share processes (no site isolation): ${JSON.stringify(pids)}`)
  if (pids.same !== pids.top || pids.wrap !== pids.top || pids.pad !== pids.top || pids.sxform !== pids.top || pids.asame !== pids.frame || pids.nav === pids.top) {
    failures.push(`a same-origin frame has its own process, or N shares the top's: ${JSON.stringify(pids)}`)
  }
  console.log(`processes: ${JSON.stringify(pids)}; protocol attached: ${wc.debugger.isAttached()}`)
  if (failures.length) {
    console.log('\nFAIL:\n  ' + failures.join('\n  '))
    return 1
  }

  const js = (doc, code) => within(docs[doc].executeJavaScript(code), 3000, 'unresponsive')
  const state = (doc) => js(doc, '__state()')
  const DOCS = ['top', 'frame', 'nested', 'xform']
  const reset = async () => {
    for (const d of [...DOCS, 'same', 'wrap', 'inner', 'pad', 'sxform', 'xorigin', 'sandbox', 'asame']) await js(d, '__reset()')
    await sleep(80)
  }
  const settle = (ms = 150) => sleep(ms)
  const want = (ok, text) => ok || failures.push(text)

  // The view road: main's own gate and lane over the real view, as index.ts wires them (one
  // viewer, its bucket refilled on every call so no round is cut by the rate cap).
  let t = 0
  const PANEL = { windowId: owner.id, pluginId: 'check', panelId: 'view' }
  const target = {
    size: () => view.size(),
    send: (events) => view.sendInput(events),
    insertText: (text) => view.insertText(text),
    editCommand: (input) => view.editCommand(input),
    readSelection: () => view.readSelection()
  }
  const input = new WebviewInput({ isViewer: () => true, claimOwner: () => {}, target: () => target, now: () => (t += 10_000) })
  const viewKey = (type, key, modifiers = []) => input.accept(PANEL, 'web:1', [{ kind: 'key', type, key, modifiers }])
  const viewPress = (key, modifiers = []) => {
    viewKey('down', key, modifiers)
    viewKey('up', key, modifiers)
  }
  const typeView = (text) => {
    for (const ch of text) viewPress(ch)
  }

  // One shape for every road: mouse (move|down|up, x, y, held, clickCount), wheel, key (down|up, key, mods), text.
  const protocolRoad = (sessionId, dy) => {
    const send = (method, params) => (sessionId ? wc.debugger.sendCommand(method, params, sessionId) : wc.debugger.sendCommand(method, params)).catch((e) => console.log(`${method}: ${e.message}`))
    return {
      mouse: (type, x, y, held = false, clickCount = 1) => {
        const kind = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[type]
        void send('Input.dispatchMouseEvent', { type: kind, x, y: y - dy, button: type === 'move' && !held ? 'none' : 'left', buttons: held || type === 'down' ? 1 : 0, clickCount: type === 'move' ? 0 : clickCount })
      },
      wheel: (x, y, deltaY) => void send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y: y - dy, deltaX: 0, deltaY }),
      key: (type, key, modifiers = []) => {
        const m = modifiers.reduce((a, k) => a | BITS[k], 0)
        const upper = key.toUpperCase()
        const text = type === 'down' && m === 0 ? key : undefined
        const commands = type === 'down' && key === 'a' && (m === BITS.control || m === BITS.meta) ? ['selectAll'] : undefined
        void send('Input.dispatchKeyEvent', {
          type: type === 'down' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
          key,
          code: 'Key' + upper,
          windowsVirtualKeyCode: upper.charCodeAt(0),
          modifiers: m,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...(commands ? { commands } : {})
        })
      },
      text: (text) => send('Input.insertText', { text })
    }
  }
  const roads = {
    raw: {
      mouse: (type, x, y, held = false, clickCount = 1) => {
        const kind = { move: 'mouseMove', down: 'mouseDown', up: 'mouseUp' }[type]
        wc.sendInputEvent({ type: kind, x, y, button: 'left', clickCount, modifiers: held ? ['leftbuttondown'] : [] })
      },
      wheel: (x, y, deltaY) => wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -deltaY }),
      key: (type, key, modifiers = []) => {
        wc.sendInputEvent({ type: type === 'down' ? 'keyDown' : 'keyUp', keyCode: key, modifiers })
        if (type === 'down' && modifiers.length === 0) wc.sendInputEvent({ type: 'char', keyCode: key })
      },
      text: (text) => wc.insertText(text)
    },
    protocol: protocolRoad(undefined, 0),
    child: protocolRoad(childSession, 200),
    view: {
      mouse: (type, x, y, held = false, clickCount = 1) =>
        input.accept(PANEL, 'web:1', [
          type === 'move'
            ? { kind: 'pointer', type: 'move', x, y, modifiers: held ? ['leftbuttondown'] : [] }
            : { kind: 'pointer', type, x, y, button: 'left', clickCount, modifiers: type === 'up' ? [] : [] }
        ]),
      wheel: (x, y, deltaY) => input.accept(PANEL, 'web:1', [{ kind: 'wheel', x, y, deltaX: 0, deltaY }]),
      key: viewKey,
      text: (text) => input.acceptText(PANEL, 'web:1', text)
    }
  }
  const click = (road, [x, y], clickCount = 1) => {
    road.mouse('move', x, y)
    road.mouse('down', x, y, false, clickCount)
    road.mouse('up', x, y, false, clickCount)
  }
  const at = (doc, point, opts) => toTop(doc, point, opts)

  // --- every road into each document ---
  const results = {}
  const matrix = [
    ['raw', 'top'],
    ['raw', 'frame'],
    ['protocol', 'top'],
    ['protocol', 'frame'],
    ['child', 'frame'],
    ['view', 'top'],
    ['view', 'frame'],
    ['view', 'nested'],
    ['view', 'xform']
  ]
  for (const [name, doc] of matrix) {
    const road = roads[name]
    const r = {}
    await reset()
    click(road, at(doc, LOCAL.input))
    await settle()
    road.key('down', 'a')
    road.key('up', 'a')
    road.key('down', 'b')
    road.key('up', 'b')
    await settle()
    await road.text('é')
    await settle()
    const typed = await state(doc)
    r.click = typed.log.includes('click:i')
    r.typed = typed.value
    r.selectAll = {}
    for (const mod of ['control', 'meta']) {
      road.key('down', 'a', [mod])
      road.key('up', 'a', [mod])
      await settle()
      const s = await state(doc)
      r.selectAll[mod] = s.value.length > 0 && s.sel[0] === 0 && s.sel[1] === s.value.length
      await js(doc, '__caret(i.value, i.value.length)')
    }
    // Drag across the field's text: press left of it, move with the button held, release.
    await js(doc, "i.value = 'select me please'")
    const [ix, iy] = LOCAL.input
    const p = (dx) => at(doc, [ix + dx, iy])
    road.mouse('move', ...p(-8))
    road.mouse('down', ...p(-8))
    road.mouse('move', ...p(60), true)
    road.mouse('move', ...p(150), true)
    road.mouse('up', ...p(150))
    await settle()
    const dragged = await state(doc)
    r.drag = dragged.sel[1] - dragged.sel[0]
    road.mouse('move', ...at(doc, LOCAL.box))
    road.wheel(...at(doc, LOCAL.box), 120)
    await sleep(400)
    r.wheel = (await state(doc)).scroll
    cursor = ''
    road.mouse('move', ...at(doc, LOCAL.link))
    await settle()
    r.cursor = cursor
    road.mouse('move', 620, 150)
    await settle()
    r.leftHover = doc === 'top' || (await state(doc)).log.includes('mouseout:l')
    results[`${name} ${doc}`] = r
    const gap = doc !== 'top' && name !== 'child' && name !== 'view' && !r.click ? '   (misses the cross-site iframe: expected)' : ''
    console.log(`${name.padEnd(8)} ${doc.padEnd(6)} ${JSON.stringify(r)}${gap}`)
    if (name !== 'view') continue
    want(r.click, `view ${doc}: the click did not reach the field`)
    want(r.typed === 'abé', `view ${doc}: typed ${JSON.stringify(r.typed)}, not "abé"`)
    want(r.selectAll.control && r.selectAll.meta, `view ${doc}: select all ${JSON.stringify(r.selectAll)}`)
    want(r.drag > 3, `view ${doc}: a drag selected ${r.drag} characters`)
    want(r.wheel > 0, `view ${doc}: the wheel did not scroll the box`)
    want(r.cursor === 'hand', `view ${doc}: the cursor over the link was ${JSON.stringify(r.cursor)}`)
    want(r.leftHover, `view ${doc}: leaving the frame gave its link no mouseout`)
  }

  // --- double click in each document (a word selected) ---
  for (const doc of DOCS) {
    await reset()
    await js(doc, "i.value = 'select me please'")
    const point = at(doc, [LOCAL.input[0] + 20, LOCAL.input[1]])
    click(roads.view, point, 1)
    click(roads.view, point, 2)
    await settle()
    const s = await state(doc)
    console.log(`double click ${doc}: selection ${JSON.stringify(s.sel)} of ${JSON.stringify(s.value)}`)
    want(s.sel[0] === 0 && s.sel[1] === 6, `view ${doc}: a double click selected ${JSON.stringify(s.sel)}, not the first word`)
  }

  // --- a drag that leaves A: the selection follows, A gets the release, the top nothing ---
  {
    await reset()
    await js('frame', "i.value = 'select me please'")
    const [x0, y0] = at('frame', [LOCAL.input[0] - 8, LOCAL.input[1]])
    roads.view.mouse('move', x0, y0)
    roads.view.mouse('down', x0, y0)
    roads.view.mouse('move', x0 + 80, y0, true)
    roads.view.mouse('move', 620, y0, true) // right of A (it ends at 600)
    roads.view.mouse('move', 640, y0, true)
    roads.view.mouse('up', 640, y0)
    await settle()
    const f = await state('frame')
    const top = await state('top')
    const ok = f.sel[0] === 0 && f.sel[1] === 16 && f.log.includes('mouseup:HTML') && !top.log.some((l) => l.startsWith('mousedown') || l.startsWith('mouseup'))
    console.log(`drag leaving A: A selection ${JSON.stringify(f.sel)}, A ${JSON.stringify(f.log.filter((l) => l.startsWith('mouse')))}, top ${JSON.stringify(top.log.filter((l) => l.startsWith('mouse')))}`)
    want(ok, 'view: a drag leaving A did not keep selecting there, or its release went elsewhere')
  }
  // --- a drag from the top field over A: the top keeps it ---
  {
    await reset()
    await js('top', "i.value = 'select me please'")
    const [x0, y0] = at('top', [LOCAL.input[0] - 8, LOCAL.input[1]])
    roads.view.mouse('move', x0, y0)
    roads.view.mouse('down', x0, y0)
    roads.view.mouse('move', x0 + 80, y0, true)
    roads.view.mouse('move', 300, 300, true) // over A
    roads.view.mouse('up', 300, 300)
    await settle()
    const top = await state('top')
    const f = await state('frame')
    console.log(`drag from the top over A: top selection ${JSON.stringify(top.sel)}, top ${JSON.stringify(top.log.filter((l) => l.startsWith('mouse')))}, A ${JSON.stringify(f.log.filter((l) => l.startsWith('mouse')))}`)
    // The release over A goes to the top document (its target the IFRAME element), not to A.
    want(top.sel[1] - top.sel[0] > 3 && top.log.some((l) => l.startsWith('mouseup:')) && !f.log.some((l) => l.startsWith('mousedown') || l.startsWith('mouseup')), 'view: a drag from the top over A left the top')
  }

  // --- a scrolled top page, a scrolled A: clicks and keys into A and B ---
  for (const [scroll, frameScroll] of [
    [100, 0],
    [0, 20],
    [60, 20]
  ]) {
    await reset()
    await js('top', `scrollTo(0, ${scroll})`)
    await js('frame', `scrollTo(0, ${frameScroll})`)
    await sleep(80)
    // A's field is at its y 10..40: scrolled by 20 its visible part is the top 20 px.
    const local = [LOCAL.input[0], frameScroll ? 28 : LOCAL.input[1]]
    click(roads.view, at('frame', local, { scroll, frameScroll }))
    typeView('fa')
    click(roads.view, at('nested', LOCAL.input, { scroll, frameScroll }))
    typeView('nb')
    await settle(250)
    const f = await state('frame')
    const n = await state('nested')
    const top = await state('top')
    console.log(`scrolled top ${scroll}, A ${frameScroll}: A ${JSON.stringify(f.value)}, B ${JSON.stringify(n.value)}, top ${JSON.stringify(top.value)}`)
    want(f.value === 'fa' && n.value === 'nb' && top.value === '', `view: scrolled top ${scroll} / A ${frameScroll}: A ${JSON.stringify(f.value)}, B ${JSON.stringify(n.value)}`)
  }

  // --- same-process frames: a same-site iframe S, and a cross-site X inside a same-site W, W scrolled ---
  for (const wrapScroll of [0, 20]) {
    await reset()
    await js('wrap', `scrollTo(0, ${wrapScroll})`)
    await sleep(80)
    click(roads.view, at('same', LOCAL.input))
    typeView('sa')
    click(roads.view, at('inner', LOCAL.input, { wrapScroll }))
    typeView('xb')
    roads.view.wheel(...at('inner', LOCAL.box, { wrapScroll }), 120)
    await settle(400)
    const same = await state('same')
    const inner = await state('inner')
    const top = await state('top')
    console.log(`same-process: S ${JSON.stringify(same.value)}; X in W (W scrolled ${wrapScroll}) ${JSON.stringify(inner.value)}, its box scrolled ${inner.scroll}; top ${JSON.stringify(top.value)}`)
    want(same.value === 'sa' && inner.value === 'xb' && inner.scroll > 0 && top.value === '', `view: same-process frames (W scrolled ${wrapScroll}): S ${JSON.stringify(same.value)}, X ${JSON.stringify(inner.value)} ${inner.scroll}`)
  }

  // --- dragging a link (a native drag), in the top and in A: the release comes, nothing stalls ---
  for (const doc of ['top', 'frame']) {
    await reset()
    const [lx, ly] = at(doc, LOCAL.link)
    roads.view.mouse('move', lx, ly)
    roads.view.mouse('down', lx, ly)
    roads.view.mouse('move', lx + 15, ly + 10, true)
    roads.view.mouse('move', lx + 40, ly + 30, true)
    roads.view.mouse('up', lx + 40, ly + 30)
    click(roads.view, at(doc, LOCAL.input))
    typeView('ok')
    let s
    for (let k = 0; k < 20; k++) {
      await settle(100)
      s = await state(doc)
      if (s.value === 'ok') break
    }
    console.log(`link drag in ${doc}: then typed ${JSON.stringify(s.value)}`)
    want(s.value === 'ok', `view: after a link drag in ${doc} the click and keys did not land (${JSON.stringify(s.value)})`)
  }

  // --- Tab from the top field into A, then plain keys, a text and an edit chord there ---
  {
    await reset()
    click(roads.view, at('top', LOCAL.input))
    await settle()
    for (let n = 0; n < 6 && (await state('top')).active !== 'A'; n++) {
      viewPress('Tab')
      await settle()
    }
    for (let n = 0; n < 4 && (await state('frame')).active !== 'i'; n++) {
      viewPress('Tab')
      await settle()
    }
    const before = await state('frame')
    typeView('qw')
    await roads.view.text('é')
    viewPress('a', ['meta'])
    await settle()
    const f = await state('frame')
    const top = await state('top')
    console.log(`Tab into A: A active ${JSON.stringify(before.active)}, then "qw" é Cmd+A → A ${JSON.stringify(f.value)} ${JSON.stringify(f.sel)}, top ${JSON.stringify(top.value)} ${JSON.stringify(top.log.filter((l) => l.startsWith('keydown')))}`)
    want(f.value === 'qwé' && f.sel[0] === 0 && f.sel[1] === 3 && top.value === '', 'view: keys after Tab into A did not land there')
  }

  // --- a select in each document (the top, A, B in A, T at scale(0.5)): the popup, a choice ---
  // Through a second WebviewInput wired as index.ts wires it in server mode (hit tests, popups,
  // selection pushes); the one above has none, so its left presses are never held. The popup must
  // come with the select's options at its place in the top page (the frame's rectangle mapped
  // through its owners' boxes), the press and release must not reach the document, the select must
  // hold the focus (and every frame above it its frame), and a choice must set the value there
  // and fire input and change there. Then copy: a word double-clicked in each document, and a
  // field's selected text, read where the focus is (view.readSelection, and the pushed selection).
  {
    const popups = []
    const pushedText = []
    const selTarget = {
      ...target,
      epoch: () => view.inputEpoch(),
      send: (events, epoch) => view.sendInput(events, epoch),
      hitSelect: (x, y, id, epoch) => view.hitSelect(x, y, id, epoch),
      chooseSelect: (id, index, epoch) => view.chooseSelect(id, index, epoch)
    }
    const selInput = new WebviewInput({
      isViewer: () => true,
      claimOwner: () => {},
      target: () => selTarget,
      now: () => (t += 10_000),
      pushSelect: (_view, event) => void popups.push(event),
      pushSelection: (_view, event) => void pushedText.push(event.text)
    })
    const selPointer = (type, [x, y], clickCount = 1) =>
      selInput.accept(PANEL, 'web:2', [type === 'move' ? { kind: 'pointer', type, x, y } : { kind: 'pointer', type, x, y, button: 'left', clickCount }])
    const selClick = (point, clickCount = 1) => {
      selPointer('move', point)
      selPointer('down', point, clickCount)
      selPointer('up', point, clickCount)
    }
    const selKey = (key, modifiers = []) => {
      selInput.accept(PANEL, 'web:2', [{ kind: 'key', type: 'down', key, modifiers }])
      selInput.accept(PANEL, 'web:2', [{ kind: 'key', type: 'up', key, modifiers }])
    }
    /** The frames above each document, outermost first: [document, its owner's id there]. */
    const ABOVE = { top: [], frame: [['top', 'A']], nested: [['top', 'A'], ['frame', 'B']], xform: [['top', 'T']] }
    const SCALE = { top: 1, frame: 1, nested: 1, xform: 0.5 }
    for (const doc of DOCS) {
      await reset()
      popups.length = 0
      selClick(at(doc, LOCAL.select))
      for (let k = 0; k < 40 && popups.length === 0; k++) await sleep(25)
      const popup = popups[0]
      const s = await state(doc)
      const above = []
      for (const [d, owner] of ABOVE[doc]) above.push(`${d} ${(await state(d)).active}${(await state(d)).active === owner ? '' : ` (not ${owner})`}`)
      const [ex, ey] = at(doc, [SELECT_RECT.x, SELECT_RECT.y])
      const scale = SCALE[doc]
      const r = popup?.rect
      const placed = !!r && Math.abs(r.x - ex) <= 1 && Math.abs(r.y - ey) <= 1 && Math.abs(r.width - SELECT_RECT.width * scale) <= 1 && Math.abs(r.height - SELECT_RECT.height * scale) <= 1
      const labels = popup ? popup.options.map((o) => `${o.label}${o.disabled ? '(off)' : ''}${o.group ? `[${o.group}]` : ''}`).join(',') : ''
      const pressed = s.log.filter((l) => l.startsWith('mousedown') || l.startsWith('mouseup') || l.startsWith('click'))
      console.log(`select in ${doc}: popup ${popup ? `${labels} selected ${popup.selected} at ${JSON.stringify(r)} (want ${ex},${ey} ${SELECT_RECT.width * scale}x${SELECT_RECT.height * scale})` : 'none'}; ${doc} active ${s.active}${above.length ? `, above: ${above.join(', ')}` : ''}; presses there ${JSON.stringify(pressed)}`)
      want(!!popup, `select in ${doc}: no popup`)
      if (!popup) continue
      want(labels === 'one,two,three(off),four[G]' && popup.selected === 0, `select in ${doc}: the popup listed ${labels}, selected ${popup.selected}`)
      want(placed, `select in ${doc}: the popup at ${JSON.stringify(r)}, not over the select`)
      want(pressed.length === 0, `select in ${doc}: the press reached the document (${JSON.stringify(pressed)})`)
      want(s.active === 's' && above.every((a) => !a.includes('(not')), `select in ${doc}: the focus is not on the select (${s.active}; ${above.join(', ')})`)
      selInput.acceptChoice(PANEL, 'web:2', popup.id, 1)
      let chosen
      for (let k = 0; k < 20; k++) {
        await settle(50)
        chosen = await state(doc)
        if (chosen.sv === 'two') break
      }
      console.log(`  chose "two" in ${doc}: value ${JSON.stringify(chosen.sv)}, events ${JSON.stringify(chosen.chg)}`)
      want(chosen.sv === 'two' && chosen.chg.join() === 'input:two,change:two', `select in ${doc}: the choice gave ${JSON.stringify(chosen.sv)} ${JSON.stringify(chosen.chg)}`)
      // The others' selects are untouched (the choice went to the document the popup came from).
      for (const other of DOCS.filter((d) => d !== doc)) {
        const o = await state(other)
        want(o.sv === 'one' && o.chg.length === 0, `select in ${doc}: ${other}'s select changed too (${o.sv} ${JSON.stringify(o.chg)})`)
      }
    }
    // Copy: a word of each document's paragraph double-clicked (its role's name), then a field's
    // text selected by Ctrl+A there; each read where the focus is, the top document last again.
    for (const doc of [...DOCS, 'top']) {
      await reset()
      pushedText.length = 0
      selClick(at(doc, LOCAL.word), 1)
      selClick(at(doc, LOCAL.word), 2)
      await settle(250)
      const word = await within(view.readSelection(), 3000, 'unanswered')
      const pushedWord = pushedText.at(-1)
      selClick(at(doc, LOCAL.input))
      for (const ch of `copy-${doc}`) selKey(ch)
      selKey('a', ['control'])
      await settle(250)
      const field = await within(view.readSelection(), 3000, 'unanswered')
      const pushedField = pushedText.at(-1)
      console.log(`copy in ${doc}: word ${JSON.stringify(word)} (pushed ${JSON.stringify(pushedWord)}), field ${JSON.stringify(field)} (pushed ${JSON.stringify(pushedField)})`)
      want(word === doc && pushedWord === doc, `copy in ${doc}: the double-clicked word read ${JSON.stringify(word)}, pushed ${JSON.stringify(pushedWord)}`)
      want(field === `copy-${doc}` && pushedField === `copy-${doc}`, `copy in ${doc}: the field's selection read ${JSON.stringify(field)}, pushed ${JSON.stringify(pushedField)}`)
    }
    // X (cross-site) inside the same-site W, X scrolled by 100 (its select and paragraph are below
    // its 120 px): the route through W's document, the rectangle through X's scroll; the focus walk
    // looks into W's document (same site) to find X.
    {
      await reset()
      popups.length = 0
      await js('inner', 'scrollTo(0, 100)')
      await sleep(80)
      const inX = ([x, y]) => toTop('inner', [x, y - 100])
      selClick(inX(LOCAL.select))
      for (let k = 0; k < 40 && popups.length === 0; k++) await sleep(25)
      const popup = popups[0]
      const [ex, ey] = inX([SELECT_RECT.x, SELECT_RECT.y])
      const r = popup?.rect
      const placed = !!r && Math.abs(r.x - ex) <= 1 && Math.abs(r.y - ey) <= 1 && Math.abs(r.width - SELECT_RECT.width) <= 1 && Math.abs(r.height - SELECT_RECT.height) <= 1
      if (popup) selInput.acceptChoice(PANEL, 'web:2', popup.id, 3)
      await settle(250)
      const x = await state('inner')
      pushedText.length = 0
      selClick(inX(LOCAL.word), 1)
      selClick(inX(LOCAL.word), 2)
      await settle(250)
      const word = await within(view.readSelection(), 3000, 'unanswered')
      console.log(`select and copy in X inside W (X scrolled 100): popup at ${JSON.stringify(r)} (want ${ex},${ey}), chose "four": ${JSON.stringify(x.sv)} ${JSON.stringify(x.chg)}; word ${JSON.stringify(word)} (pushed ${JSON.stringify(pushedText.at(-1))})`)
      want(placed, `select in X inside W: the popup at ${JSON.stringify(r)}, not over the select`)
      want(x.sv === 'four' && x.chg.join() === 'input:four,change:four', `select in X inside W: the choice gave ${JSON.stringify(x.sv)} ${JSON.stringify(x.chg)}`)
      want(word === 'inner' && pushedText.at(-1) === 'inner', `copy in X inside W: the double-clicked word read ${JSON.stringify(word)}`)
    }
    // Same-origin frames (main's scripts step into their documents, design-web-browser.md §4.4) and
    // what is still keyboard-only. Helpers: a select clicked (the popup, where, the presses the
    // document got, then "two" chosen), a word and a field's text copied, a field's text cut (as the
    // browser's onCut, web/webview-canvas.tsx: the pushed selection is the clipboard's, then Delete).
    const waitPopup = async () => {
      for (let k = 0; k < 40 && popups.length === 0; k++) await sleep(25)
      return popups[0]
    }
    const trySelect = async (doc, to, scale = 1) => {
      popups.length = 0
      selClick(to(LOCAL.select))
      const popup = await waitPopup()
      const s = await state(doc)
      const [ex, ey] = to([SELECT_RECT.x, SELECT_RECT.y])
      const r = popup?.rect
      const placed = !!r && Math.abs(r.x - ex) <= 1 && Math.abs(r.y - ey) <= 1 && Math.abs(r.width - SELECT_RECT.width * scale) <= 1 && Math.abs(r.height - SELECT_RECT.height * scale) <= 1
      const pressed = s.log.filter((l) => l.startsWith('mousedown') || l.startsWith('mouseup') || l.startsWith('click'))
      let chosen = s
      if (popup) {
        selInput.acceptChoice(PANEL, 'web:2', popup.id, 1)
        for (let k = 0; k < 20; k++) {
          await settle(50)
          chosen = await state(doc)
          if (chosen.sv === 'two') break
        }
      }
      return { popup, r, want: [ex, ey], placed, pressed, active: s.active, sv: chosen.sv, chg: chosen.chg }
    }
    /** `toField`: the field's mapping when the word's needs the document scrolled (`beforeField` undoes it). */
    const tryCopy = async (doc, to, toField = to, beforeField = async () => {}) => {
      pushedText.length = 0
      selClick(to(LOCAL.word), 1)
      selClick(to(LOCAL.word), 2)
      await settle(250)
      const word = await within(view.readSelection(), 3000, 'unanswered')
      const pushedWord = pushedText.at(-1)
      await beforeField()
      selClick(toField(LOCAL.input))
      for (const ch of `copy-${doc}`) selKey(ch)
      selKey('a', ['control'])
      await settle(250)
      const field = await within(view.readSelection(), 3000, 'unanswered')
      return { word, pushedWord, field, pushedField: pushedText.at(-1) }
    }
    const tryCut = async (doc, to) => {
      pushedText.length = 0
      selClick(to(LOCAL.input))
      for (const ch of `cut-${doc}`) selKey(ch)
      selKey('a', ['control'])
      await settle(250)
      const clipboard = pushedText.at(-1)
      if (clipboard) selKey('Delete')
      await settle(200)
      return { clipboard, left: (await state(doc)).value }
    }
    const selectOk = (name, doc, r, owners = []) => {
      console.log(`select in ${name}: popup ${r.popup ? `at ${JSON.stringify(r.r)} (want ${r.want})` : 'none'}; presses there ${JSON.stringify(r.pressed)}; active ${r.active}${owners.map(([d, a]) => `, ${d} ${a}`).join('')}; chose "two": ${JSON.stringify(r.sv)} ${JSON.stringify(r.chg)}`)
      want(!!r.popup && r.placed, `select in ${name}: ${r.popup ? `the popup at ${JSON.stringify(r.r)}, not over the select (${r.want})` : 'no popup'}`)
      want(r.pressed.length === 0, `select in ${name}: the press reached the document (${JSON.stringify(r.pressed)})`)
      want(r.active === 's' && owners.every(([, a, w]) => a === w), `select in ${name}: the focus is not on the select (${r.active}; ${JSON.stringify(owners)})`)
      want(r.sv === 'two' && r.chg.join() === 'input:two,change:two', `select in ${name}: the choice gave ${JSON.stringify(r.sv)} ${JSON.stringify(r.chg)}`)
    }
    const copyOk = (name, doc, c) => {
      console.log(`copy in ${name}: word ${JSON.stringify(c.word)} (pushed ${JSON.stringify(c.pushedWord)}), field ${JSON.stringify(c.field)} (pushed ${JSON.stringify(c.pushedField)})`)
      want(c.word === doc && c.pushedWord === doc, `copy in ${name}: the double-clicked word read ${JSON.stringify(c.word)}, pushed ${JSON.stringify(c.pushedWord)}`)
      want(c.field === `copy-${doc}` && c.pushedField === `copy-${doc}`, `copy in ${name}: the field's selection read ${JSON.stringify(c.field)}, pushed ${JSON.stringify(c.pushedField)}`)
    }
    const cutOk = (name, doc, c) => {
      console.log(`cut in ${name}: clipboard ${JSON.stringify(c.clipboard)}, the field left ${JSON.stringify(c.left)}`)
      want(c.clipboard === `cut-${doc}` && c.left === '', `cut in ${name}: clipboard ${JSON.stringify(c.clipboard)}, the field left ${JSON.stringify(c.left)}`)
    }

    // S, same-origin in the top (scrolled 100: its select and paragraph are below its 110 px).
    {
      await reset()
      await js('same', 'scrollTo(0, 100)')
      await sleep(80)
      const inS = (p) => toTop('same', p, { own: 100 })
      selectOk('S (same-origin)', 'same', await trySelect('same', inS), [['top', (await state('top')).active, 'S']])
      await reset()
      await js('same', 'scrollTo(0, 100)')
      await sleep(80)
      const inS0 = (p) => toTop('same', p)
      const unscroll = async () => {
        await js('same', 'scrollTo(0, 0)')
        await sleep(80)
      }
      copyOk('S (same-origin)', 'same', await tryCopy('same', inS, inS0, unscroll))
      await reset()
      cutOk('S (same-origin)', 'same', await tryCut('same', inS0))
    }
    // P, same-origin below the top's fold with an uneven border (3 left, 5 top) and padding (4 left, 6
    // top), scrolled 30 itself: the point and the rectangle through the frame's box.
    {
      await reset()
      await js('top', `scrollTo(0, ${FOLD})`)
      await js('pad', 'scrollTo(0, 30)')
      await sleep(80)
      const inP = (p) => toTop('pad', p, { scroll: FOLD, own: 30 })
      const r = await trySelect('pad', inP)
      selectOk('P (same-origin, border and padding, scrolled)', 'pad', r, [['top', (await state('top')).active, 'P']])
      // Unscrolled for copy: its field is at its y 10..40.
      await reset()
      await js('top', `scrollTo(0, ${FOLD})`)
      await sleep(80)
      copyOk('P (same-origin, border and padding)', 'pad', await tryCopy('pad', (p) => toTop('pad', p, { scroll: FOLD })))
    }
    // Q, same-origin inside the cross-site A (A scrolled to it, Q scrolled 20): the script runs in A's
    // world (the router's route) and steps into Q from there; A's rectangle maps it to the top.
    {
      const prep = async () => {
        await reset()
        await js('frame', `scrollTo(0, ${A_FOLD})`)
        await js('asame', 'scrollTo(0, 20)')
        await sleep(80)
      }
      const inQ = (p) => toTop('asame', p, { frameScroll: A_FOLD, own: 20 })
      await prep()
      const r = await trySelect('asame', inQ)
      selectOk('Q (same-origin in cross-site A)', 'asame', r, [['A', (await state('frame')).active, 'Q'], ['top', (await state('top')).active, 'A']])
      await prep()
      copyOk('Q (same-origin in cross-site A)', 'asame', await tryCopy('asame', inQ))
      await prep()
      cutOk('Q (same-origin in cross-site A)', 'asame', await tryCut('asame', inQ))
    }
    // Cut in A itself (cross-site; worked before same-origin frames did: a regression row).
    {
      await reset()
      cutOk('A (cross-site)', 'frame', await tryCut('frame', (p) => toTop('frame', p)))
    }
    // U, same-origin at scale(0.5): no exact inverse in the script, so no popup and the press goes to
    // the page as a click (a popup in the wrong place would be the failure).
    {
      await reset()
      await js('top', `scrollTo(0, ${FOLD})`)
      await sleep(80)
      const r = await trySelect('sxform', (p) => toTop('sxform', p, { scroll: FOLD }), 0.5)
      console.log(`select in U (same-origin at scale(0.5), refused): popup ${r.popup ? JSON.stringify(r.r) : 'none'}, presses there ${JSON.stringify(r.pressed)}`)
      want(!r.popup && r.pressed.some((l) => l === 'mousedown:s'), `select in U (same-origin, scaled): popup ${JSON.stringify(r.r)}, presses ${JSON.stringify(r.pressed)}`)
    }
    // Printed, never failures: O, same-site but cross-origin (127.0.0.1 on a second port: the top's
    // process, its document unreadable from the isolated world), and D, sandboxed (allow-scripts, an
    // opaque origin; its process printed: Chromium may isolate sandboxed frames, then the router
    // reaches it as it does a cross-site frame). Keyboard-only where nothing reaches them.
    for (const [doc, name] of [
      ['xorigin', 'O (same-site, cross-origin)'],
      ['sandbox', 'D (sandboxed)']
    ]) {
      await reset()
      await js('top', `scrollTo(0, ${FOLD})`)
      await sleep(80)
      const to = (p) => toTop(doc, p, { scroll: FOLD })
      const r = await trySelect(doc, to)
      await reset()
      await js('top', `scrollTo(0, ${FOLD})`)
      await sleep(80)
      const c = await tryCopy(doc, to)
      // In the top's process main's scripts cannot read it (keyboard-only); in its own the router reaches it.
      const own = docs[doc].osProcessId === docs.top.osProcessId ? "the top's process: known limitation, keyboard-only" : 'its own process: routed as a cross-site frame'
      console.log(
        `${name} (${own}): select popup ${r.popup ? `at ${JSON.stringify(r.r)}, chose ${JSON.stringify(r.sv)}` : 'none'}, presses there ${JSON.stringify(r.pressed)}; copy word ${JSON.stringify(c.word)}, field ${JSON.stringify(c.field)}`
      )
    }
    // N, cross-site, navigates to another cross-site document (nav2 on [::1]) while its popup is open:
    // the old popup's choice finds nothing (its frame's session went), then a select in the new
    // document works.
    {
      await reset()
      await js('top', `scrollTo(0, ${FOLD})`)
      await sleep(80)
      const inN = (p) => toTop('nav', p, { scroll: FOLD })
      popups.length = 0
      selClick(inN(LOCAL.select))
      const old = await waitPopup()
      await js('top', `document.getElementById('N').src = 'http://[::1]:${port}/?role=nav2'; true`)
      for (let k = 0; k < 50; k++) {
        const fr = wc.mainFrame.framesInSubtree.find((f) => new URL(f.url || 'about:blank').searchParams.get('role') === 'nav2')
        if (fr && (await within(fr.executeJavaScript('document.readyState').catch(() => ''), 1000, '')) === 'complete') {
          docs.nav2 = fr
          break
        }
        await sleep(100)
      }
      let stale = { sv: 'never loaded', chg: [] }
      let fresh
      if (docs.nav2) {
        await settle(200)
        if (old) selInput.acceptChoice(PANEL, 'web:2', old.id, 1)
        await settle(300)
        stale = await state('nav2')
        fresh = await trySelect('nav2', (p) => toTop('nav2', p, { scroll: FOLD }))
      }
      console.log(
        `N navigated with its popup open: old popup ${old ? 'shown' : 'none'}, its choice then gave ${JSON.stringify(stale.sv)} ${JSON.stringify(stale.chg)}; the new document's select: popup ${fresh?.popup ? 'shown' : 'none'}, chose ${JSON.stringify(fresh?.sv)} ${JSON.stringify(fresh?.chg)}`
      )
      want(!!old, 'navigating N: no popup before the navigation')
      want(stale.sv === 'one' && stale.chg.length === 0, `navigating N: the old popup's choice changed the new document (${JSON.stringify(stale.sv)} ${JSON.stringify(stale.chg)})`)
      want(!!fresh?.popup && fresh.placed && fresh.sv === 'two' && fresh.chg.join() === 'input:two,change:two', `navigating N: the new document's select ${JSON.stringify(fresh && { popup: !!fresh.popup, placed: fresh.placed, sv: fresh.sv, chg: fresh.chg })}`)
      await js('top', 'scrollTo(0, 0)')
    }
  }

  // --- every allow-listed key: the view road against the raw road, in the top textarea ---
  {
    const keys = []
    for (let c = 0x21; c <= 0x7e; c++) {
      const k = String.fromCharCode(c)
      const shifted = /[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(k)
      keys.push([k, shifted ? ['shift'] : []])
    }
    for (const k of ['Enter', 'Backspace', 'Delete', 'Escape', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'F1', 'F2', 'F3', 'F4', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11']) keys.push([k, []])
    const SIZE = { width: 1000, height: 700 }
    const runKeys = async (send) => {
      await reset()
      await js('top', "__tcaret('', 0)")
      for (const [key, modifiers] of keys) {
        send({ kind: 'key', type: 'down', key, modifiers })
        send({ kind: 'key', type: 'up', key, modifiers })
      }
      await settle(400)
      return state('top')
    }
    const raw = await runKeys((ev) => {
      for (const e of toElectronEvents(ev, SIZE)) wc.sendInputEvent(e)
    })
    const routed = await runKeys((ev) => input.accept(PANEL, 'web:1', [ev]))
    const pick = (s) => s.log.filter((l) => l.startsWith('key'))
    const a = pick(raw)
    const b = pick(routed)
    const diff = []
    for (let n = 0; n < Math.max(a.length, b.length) && diff.length < 8; n++) if (a[n] !== b[n]) diff.push(`raw ${a[n]} / view ${b[n]}`)
    console.log(`allow-listed keys (${keys.length}): ${a.length} raw and ${b.length} view key events, ${diff.length ? 'differ:\n    ' + diff.join('\n    ') : 'the same'}; text ${raw.text === routed.text ? 'the same' : `raw ${JSON.stringify(raw.text)} / view ${JSON.stringify(routed.text)}`}`)
    want(diff.length === 0 && a.length === b.length && raw.text === routed.text && routed.text.length > 0, 'view: the allow-listed keys differ from the raw road')
  }
  // A plain key down the page prevents types nothing (its char is suppressed, as from a keyboard).
  {
    await reset()
    click(roads.view, at('top', LOCAL.input))
    await js('top', "__preventPlain = 'q'")
    typeView('qrq')
    await settle()
    const s = await state('top')
    console.log(`prevented plain "q": typed ${JSON.stringify(s.value)}`)
    want(s.value === 'r', `view: a prevented key down still typed (${JSON.stringify(s.value)})`)
  }

  // --- S6 through the view road (top document) ---
  const focusTop = async () => {
    await reset()
    roads.view.mouse('down', ...LOCAL.input)
    roads.view.mouse('up', ...LOCAL.input)
    await settle()
  }
  const value = async () => (await state('top')).value
  await focusTop()
  typeView('hello')
  await settle()
  viewPress('z', ['meta'])
  await settle()
  const undone = await value()
  viewPress('Z', ['meta', 'shift'])
  await settle()
  const redone = await value()
  viewPress('z', ['control'])
  await settle()
  viewPress('y', ['control'])
  await settle()
  const redoneY = await value()
  console.log(`undo / redo: Cmd+Z ${JSON.stringify(undone)}, Cmd+Shift+Z ${JSON.stringify(redone)}, Ctrl+Z then Ctrl+Y ${JSON.stringify(redoneY)}`)
  want(undone === '' && redone === 'hello' && redoneY === 'hello', 'view: undo and redo')

  await focusTop()
  typeView('abc')
  await settle()
  await js('top', '__prevent = true')
  viewPress('a', ['meta'])
  await settle()
  const prevented = await state('top')
  viewPress('z', ['control'])
  await settle()
  const preventedUndo = await value()
  const sawKeys = prevented.log.filter((l) => l.startsWith('keydown:i:a'))
  console.log(`prevented key down: after Cmd+A selection ${JSON.stringify(prevented.sel)}, after Ctrl+Z ${JSON.stringify(preventedUndo)}, the page saw ${JSON.stringify(sawKeys)}`)
  want(prevented.sel[0] === 3 && preventedUndo === 'abc' && sawKeys.some((k) => k.startsWith('keydown:i:a+M')), 'view: a prevented key down still ran its command (or the page never saw it)')

  // One undo group, not two: "ab", caret away and back (a new group), "cd", one Ctrl+Z.
  await focusTop()
  typeView('ab')
  viewPress('ArrowLeft')
  viewPress('ArrowRight')
  typeView('cd')
  await settle()
  viewPress('z', ['control'])
  await settle()
  const once = await value()
  console.log(`one Ctrl+Z after "ab", ←, →, "cd": ${JSON.stringify(once)} (two undos would leave "")`)
  want(once === 'ab', `view: one Ctrl+Z left ${JSON.stringify(once)}, not "ab"`)

  // --- editing keys through the view road, in the field (what a Mac's text field does) ---
  const L = 'one two three'
  const keyProbes = [
    ['Backspace', [], 13, 'value', 'one two thre'],
    ['Delete', [], 0, 'value', 'ne two three'],
    ['ArrowLeft', [], 13, 'caret', 12],
    ['ArrowRight', [], 0, 'caret', 1],
    ['ArrowLeft', ['shift'], 13, 'sel', '12-13'],
    ['Home', [], 13, 'caret', 0],
    ['End', [], 0, 'caret', 13],
    ['ArrowLeft', ['alt'], 13, 'caret', 8],
    ['ArrowRight', ['alt'], 0, 'caret', 3],
    ['ArrowLeft', ['meta'], 13, 'caret', 0],
    ['ArrowRight', ['meta'], 0, 'caret', 13],
    ['ArrowLeft', ['meta', 'shift'], 13, 'sel', '0-13'],
    ['ArrowRight', ['meta', 'shift'], 0, 'sel', '0-13'],
    ['ArrowLeft', ['control'], 13, 'caret', 'Linux: 8'],
    ['Backspace', ['alt'], 13, 'value', 'one two '],
    ['Backspace', ['meta'], 13, 'value', ''],
    ['Backspace', ['control'], 13, 'value', 'Linux: one two ']
  ]
  for (const [key, mods, start, what, expected] of keyProbes) {
    await focusTop()
    await js('top', `__caret(${JSON.stringify(L)}, ${start})`)
    await sleep(40)
    viewPress(key, mods)
    await settle()
    const s = await state('top')
    const got = what === 'value' ? s.value : what === 'caret' ? (s.sel[0] === s.sel[1] ? s.sel[0] : `${s.sel[0]}-${s.sel[1]}`) : `${s.sel[0]}-${s.sel[1]}`
    const expectedHere = typeof expected === 'string' && expected.startsWith('Linux: ') ? (process.platform === 'darwin' ? undefined : expected.slice(7)) : expected
    const label = `${[...mods, key].join('+')}`
    const ok = expectedHere === undefined ? '' : String(got) === String(expectedHere) ? 'ok' : 'MISS'
    if (ok === 'MISS') {
      const text = `view: key ${label} gave ${JSON.stringify(got)}, a Mac's field gives ${JSON.stringify(expectedHere)}`
      if (process.platform !== 'darwin' && mods.includes('alt')) linuxKeyLimits.push(text)
      else failures.push(text)
    }
    console.log(`  key ${label.padEnd(22)} ${what} ${JSON.stringify(got)}${expectedHere === undefined ? '' : ` (want ${JSON.stringify(expectedHere)})`} ${ok}`)
  }

  // --- the Mac line keys in a textarea, caret mid-line (a line is not the document there) ---
  {
    const T = 'one two\nthree four five\nsix'
    const caret = 14 // in "four" of the second line, which spans 8..23
    const lineProbes = [
      ['ArrowLeft', ['meta'], 'tsel', '8-8'],
      ['ArrowRight', ['meta'], 'tsel', '23-23'],
      ['ArrowLeft', ['meta', 'shift'], 'tsel', '8-14'],
      ['ArrowRight', ['meta', 'shift'], 'tsel', '14-23'],
      ['ArrowUp', ['meta'], 'tsel', '0-0'],
      ['ArrowDown', ['meta'], 'tsel', `${T.length}-${T.length}`],
      ['ArrowUp', ['meta', 'shift'], 'tsel', '0-14'],
      ['ArrowDown', ['meta', 'shift'], 'tsel', `14-${T.length}`],
      ['Backspace', ['meta'], 'text', 'one two\nfour five\nsix'],
      ['e', ['control'], 'tsel', '(Emacs, not mapped) 23-23'],
      ['k', ['control'], 'text', '(Emacs, not mapped) one two\nthree \nsix']
    ]
    for (const [key, mods, what, expected] of lineProbes) {
      await reset()
      await js('top', `__tcaret(${JSON.stringify(T)}, ${caret})`)
      await sleep(40)
      viewPress(key, mods)
      await settle()
      const s = await state('top')
      const got = what === 'text' ? s.text : `${s.tsel[0]}-${s.tsel[1]}`
      const probe = expected.startsWith('(')
      const want0 = probe ? expected.slice(expected.indexOf(')') + 2) : expected
      const ok = got === want0 ? 'ok' : probe ? 'miss (probe)' : 'MISS'
      if (ok === 'MISS') failures.push(`view: line key ${[...mods, key].join('+')} gave ${JSON.stringify(got)}, a Mac's textarea gives ${JSON.stringify(want0)}`)
      console.log(`  line key ${[...mods, key].join('+').padEnd(22)} ${what} ${JSON.stringify(got)} (want ${JSON.stringify(want0)}) ${ok}`)
    }
    // And in A's field (the command follows focus into the frame).
    await reset()
    click(roads.view, at('frame', LOCAL.input))
    await settle()
    await js('frame', "__caret('one two three', 13)")
    viewPress('ArrowLeft', ['meta', 'shift'])
    await settle()
    const f = await state('frame')
    console.log(`  line key Cmd+Shift+Left in A: selection ${JSON.stringify(f.sel)}`)
    want(f.sel[0] === 0 && f.sel[1] === 13, `view: Cmd+Shift+Left in A selected ${JSON.stringify(f.sel)}`)
  }

  // --- order through the view road, across frames, nothing awaited ---
  {
    const wrong = []
    for (let n = 0; n < ROUNDS; n++) {
      await reset()
      click(roads.view, at('frame', LOCAL.input))
      typeView('abc')
      roads.view.text('é')
      typeView('d')
      click(roads.view, at('top', LOCAL.input))
      typeView('xy')
      roads.view.text('é')
      click(roads.view, at('nested', LOCAL.input))
      typeView('q')
      roads.view.text('ü')
      click(roads.view, at('xform', LOCAL.input))
      typeView('z')
      viewPress('a', ['control'])
      typeView('w')
      const wanted = { frame: 'abcéd', top: 'xyé', nested: 'qü', xform: 'w' }
      let got
      for (let k = 0; k < 20; k++) {
        await settle(100)
        got = {}
        for (const d of DOCS) got[d] = (await state(d)).value
        if (DOCS.every((d) => got[d] === wanted[d])) break
      }
      if (!DOCS.every((d) => got[d] === wanted[d])) wrong.push(got)
    }
    console.log(`order across frames (${ROUNDS} rounds: click A "abc" é "d", the top "xy" é, B "q" ü, T "z" Ctrl+A "w"): wrong ${wrong.length} ${wrong.length ? JSON.stringify(wrong.slice(0, 4)) : ''}`)
    want(wrong.length === 0, `order across frames: ${wrong.length} wrong`)
  }
  {
    let wrongSelect = 0
    let wrongText = 0
    const samples = []
    for (let n = 0; n < ROUNDS; n++) {
      await focusTop()
      typeView('abc')
      roads.view.text('é')
      viewPress('a', ['control'])
      typeView('x')
      await settle()
      const s1 = await value()
      if (s1 !== 'x') {
        wrongSelect++
        if (samples.length < 6) samples.push(s1)
      }
      await focusTop()
      typeView('abc')
      roads.view.text('é')
      typeView('d')
      await settle()
      const s2 = await value()
      if (s2 !== 'abcéd') {
        wrongText++
        if (samples.length < 6) samples.push(s2)
      }
    }
    console.log(`order in the top (${ROUNDS} rounds): "abc" é Ctrl+A "x" wrong ${wrongSelect}, "abc" é "d" wrong ${wrongText} ${samples.length ? JSON.stringify(samples) : ''}`)
    want(wrongSelect === 0 && wrongText === 0, `order in the top: ${wrongSelect} + ${wrongText} wrong`)
  }

  // --- the router's cost per pointer event (hit test, dispatch, answer), printed ---
  {
    await reset()
    const cost = {}
    for (const doc of DOCS) {
      const [x, y] = at(doc, LOCAL.box)
      const t0 = performance.now()
      for (let n = 0; n < 30; n++) {
        view.sendInput([{ type: 'mouseMove', x: x + (n % 5), y, modifiers: [] }])
        await view.readSelection() // runs once every event before it was handled
      }
      cost[doc] = Number(((performance.now() - t0) / 30).toFixed(1))
    }
    console.log(`ms per pointer move, routed and answered (and a selection read): ${JSON.stringify(cost)}`)
  }

  // --- a key's cost on the page's session: the protocol's own answer, and through the router ---
  // (each typed character is three key events: key down, char, key up; a held key's repeat is a
  // key down and a char per repeat, 30 a second on a Mac). Printed: the router sends keys one at a
  // time (page-input.ts `order`), so typing lags once three answers take longer than a keystroke.
  {
    await focusTop()
    const N = 60
    const one = async (params) => wc.debugger.sendCommand('Input.dispatchKeyEvent', params)
    let t0 = performance.now()
    for (let n = 0; n < N; n++) {
      await one({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
      await one({ type: 'char', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a', unmodifiedText: 'a' })
      await one({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 })
    }
    const protocolMs = (performance.now() - t0) / (3 * N)
    await focusTop()
    t0 = performance.now()
    typeView('abcdefghij'.repeat(N / 10))
    await view.readSelection()
    const typedMs = (performance.now() - t0) / (3 * N)
    const typed = await value()
    await focusTop()
    t0 = performance.now()
    viewKey('down', 'b')
    for (let n = 0; n < N; n++) viewKey('down', 'b', ['isautorepeat'])
    viewKey('up', 'b')
    await view.readSelection()
    const repeatMs = (performance.now() - t0) / (2 * N + 3)
    const repeated = await value()
    console.log(
      `ms per key event: protocol answer ${protocolMs.toFixed(2)}; through the router, typing ${typedMs.toFixed(2)} (${typed.length} of ${N} typed), ` +
        `a held key's repeat ${repeatMs.toFixed(2)} (${repeated.length} of ${N + 1} typed)`
    )
    want(typed.length === N && repeated.length === N + 1, `view: fast typing typed ${typed.length} of ${N}, a held key ${repeated.length} of ${N + 1}`)
  }

  // --- a renderer that spins forever, then (a) a reload and (b) a cross-site navigation ---
  // A command or call the spinning page never answers stalls its road until it settles or the
  // renderer goes (rulings 2026-11-19 #7, #9, #11). A spinning renderer commits no reload and no
  // same-site navigation by itself (Electron 45, macOS and Linux: 45 s waited; no unresponsive, no
  // render-process-gone, the main frame's process the same), so the adapter's hung-page watchdog
  // (hung-navigation.ts) kills it a few seconds into (a) the reload and (b2) the same-site load and
  // starts the navigation again; (b), cross-site, commits into another process by itself. (c) is a
  // kill of this script's own, then a reload; (d) a crash (on Linux one that dumps core, which alone
  // holds the renderer 40 s), then a reload. After each the typing must reach the new page within a
  // few seconds, and after (a) the page's setup must still be there (the view outlived its
  // renderer). Printed: which events fire, what the pending promises do, and the main frame's process.
  {
    const SPIN_WAIT_MS = 20_000
    const events = []
    const t0 = performance.now()
    const stamp = () => Math.round(performance.now() - t0)
    const pid = () => {
      try {
        return wc.isDestroyed() ? -1 : wc.mainFrame.osProcessId
      } catch {
        // Between two documents: "Render frame was disposed before WebFrameMain could be accessed".
        return 'none'
      }
    }
    const note = (text) => events.push(`${stamp()} ${text} [pid ${pid()}]`)
    const on = (name, fmt = () => '') => wc.on(name, (...a) => note(name + fmt(...a)))
    on('render-process-gone', (_e, d) => ` ${d.reason}`)
    on('unresponsive')
    on('responsive')
    on('did-start-navigation', (e, url, inPlace, isMain) => ((e.isMainFrame ?? isMain) ? ` ${e.url ?? url}${(e.isSameDocument ?? inPlace) ? ' same-doc' : ''}` : ' (subframe)'))
    on('frame-created', (_e, d) => (d.frame && !d.frame.parent ? ` main frame, its pid ${d.frame.osProcessId}` : ' (subframe)'))
    let navigated = 0
    wc.on('did-navigate', () => navigated++)
    on('did-navigate', (_e, url) => ` ${url}`)
    on('did-finish-load')
    on('did-start-loading')
    on('did-stop-loading')
    on('did-fail-load', (_e, code, desc, url, isMain) => ` ${code} ${desc} ${isMain ? 'main' : 'sub'} ${url}`)
    wc.debugger.on('detach', (_e, reason) => note(`debugger detach ${reason}`))
    const outcome = (name, p) =>
      p.then(
        (v) => note(`${name} resolved ${String(JSON.stringify(v ?? null)).slice(0, 40)}`),
        (e) => note(`${name} rejected: ${e instanceof Error ? e.message : String(e)}`)
      )
    const waitFor = async (fn, ms) => {
      const end = performance.now() + ms
      while (performance.now() < end) {
        if (await fn()) return true
        await sleep(100)
      }
      return false
    }
    const field = () => within(Promise.resolve().then(() => wc.mainFrame.executeJavaScript('document.getElementById("i") ? document.getElementById("i").value : ""')).catch(() => 'no frame'), 1000, 'unresponsive')
    const spinThen = async (label, go) => {
      await within(wc.mainFrame.executeJavaScript('window.__arm = true'), 3000)
      note(`${label}: click (the page spins 30 ms later)`)
      click(roads.view, LOCAL.input)
      await sleep(100)
      // A call (the selection read), keys and a text: each one the spinning renderer never answers.
      outcome(`${label}: call`, view.readSelection())
      typeView('zz')
      outcome(`${label}: text`, view.insertText('y'))
      await sleep(1200)
      note(`${label}: go`)
      const before = navigated
      await go()
      const ready = () => within(Promise.resolve().then(() => wc.mainFrame.executeJavaScript('document.readyState')).catch(() => ''), 1000, '')
      const loaded = await waitFor(async () => navigated > before && (await ready()) === 'complete', SPIN_WAIT_MS)
      note(`${label}: new page ${loaded ? 'complete' : 'never complete'}`)
      const t1 = performance.now()
      click(roads.view, LOCAL.input)
      typeView('ok')
      const typed = await waitFor(async () => (await field()).includes('ok'), 5000)
      const got = await field()
      note(`${label}: typed after ${Math.round(performance.now() - t1)} ms: ${JSON.stringify(got)}`)
      want(typed && got === 'ok', `spin ${label}: the typing after it did not reach the new page within 5 s (${JSON.stringify(got)})`)
      return got
    }
    await view.load(`http://127.0.0.1:${port}/?role=spin`)
    note('spin page loaded')
    await spinThen('reload', async () => view.reload())
    // The view outlived its renderer: the page's protocol, the print lock in the new document's main
    // world (installed through that protocol, webview-hardening.ts), a chooser still cancelled, the
    // frame rate, and paints still reaching a sink.
    {
      const lock = await within(
        wc.mainFrame.executeJavaScript('Object.getOwnPropertyDescriptor(window, "print")?.configurable === false && window.print.toString().indexOf("native") < 0'),
        2000,
        'no answer'
      )
      let chooser = false
      const onChooser = () => (chooser = true)
      wc.debugger.on('message', (_e, method) => method === 'Page.fileChooserOpened' && onChooser())
      await within(wc.mainFrame.executeJavaScript('(() => { const f = document.createElement("input"); f.type = "file"; document.body.append(f); f.click(); return true })()', true), 2000)
      await sleep(300)
      let painted = 0
      view.setSink({ paint: () => painted++, cursor: (type) => (cursor = type) })
      view.setVisible(true)
      view.invalidate()
      await sleep(300)
      note(`after the restart: protocol ${wc.debugger.isAttached()}, print locked ${lock}, chooser intercepted ${chooser}, frame rate ${wc.getFrameRate()}, paints ${painted}`)
      want(wc.debugger.isAttached(), 'spin reload: the page\'s protocol is detached after the watchdog\'s restart')
      want(lock === true, `spin reload: window.print is not locked in the new page (${JSON.stringify(lock)})`)
      want(chooser, 'spin reload: a file chooser of the new page was not intercepted')
      want(wc.getFrameRate() === 30, `spin reload: frame rate ${wc.getFrameRate()} after the restart`)
      want(painted > 0, 'spin reload: no paint reached the sink after the restart')
    }
    await spinThen('cross-site', async () => {
      void within(
        view.load(`http://localhost:${port}/?role=spin`).then(
          () => note('cross-site: load resolved'),
          (e) => note(`cross-site: load rejected: ${e instanceof Error ? e.message : String(e)}`)
        ),
        SPIN_WAIT_MS
      )
    })
    // (b2) A same-site load (the address bar's): it would commit into the spinning process, so it
    // hangs like the reload; the watchdog's retry is what the load's own promise settles with.
    await spinThen('same-site load', async () => {
      void within(
        view.load(`http://localhost:${port}/?role=spin&again`).then(
          () => note('same-site load: load resolved'),
          (e) => note(`same-site load: load rejected: ${e instanceof Error ? e.message : String(e)}`)
        ),
        SPIN_WAIT_MS
      )
    })
    // (c) This script's own kill, then a reload (the watchdog sees a navigation with no renderer:
    // nothing to kill). SIGKILL, never
    // forcefullyCrashRenderer: on Linux that crash dumps core (systemd-coredump, a renderer's core is
    // large), and the process sits in do_exit for 40 to 50 s before render-process-gone fires (Debian
    // VM, Electron 45: 46 s and 42 s; a reload asked while it was dying never committed, so the new
    // page never came within the 20 s this case waits). A SIGKILL writes no core: gone at once on
    // Linux and macOS.
    let gone = 0
    wc.on('render-process-gone', () => gone++)
    const kill = async (label) => {
      const before = gone
      const pid = wc.getOSProcessId()
      // 0 once the renderer is gone: process.kill(0) would kill this script's whole process group.
      if (!(pid > 0)) {
        note(`${label}: no renderer to kill (os pid ${pid})`)
        return
      }
      process.kill(pid, 'SIGKILL')
      const t1 = performance.now()
      while (gone === before && performance.now() - t1 < 10_000) await sleep(50)
      note(`${label}: renderer ${pid} killed, render-process-gone ${gone > before ? `after ${Math.round(performance.now() - t1)} ms` : 'not within 10 s'}`)
    }
    if (navigated === 0 || (await field()) === 'unresponsive') {
      await kill('before (c)')
      await within(view.load(`http://127.0.0.1:${port}/?role=spin`).catch(() => {}), 10000)
      note('killed and loaded again before (c)')
    }
    await spinThen('kill, reload', async () => {
      await kill('(c)')
      view.reload()
    })
    // (d) A crash, then a reload. On macOS the renderer is gone at once; on a Linux host that pipes
    // cores to systemd-coredump it sits in do_exit 40 s and more, and the reload sent meanwhile is
    // the watchdog's (its SIGKILL ends the dump: gone 4 ms later, Debian VM).
    await spinThen('crash, reload', async () => {
      wc.forcefullyCrashRenderer()
      await sleep(500)
      view.reload()
    })
    await sleep(2000)
    console.log('spin then reload / navigate:\n  ' + events.join('\n  '))
  }

  if (logs.length) console.log('log:', JSON.stringify(logs))
  if (linuxKeyLimits.length) console.log('known limitation (a Linux Blink has no Alt word bindings; backlog streamed-mac-line-edit-keys.md):\n  ' + linuxKeyLimits.join('\n  '))
  view.destroy()
  owner.destroy()
  server.close()
  server2.close()
  if (failures.length) {
    console.log('\nFAIL:\n  ' + failures.join('\n  '))
    return 1
  }
  console.log('\nOK: the view road works in the top document and in cross-site frames (nested, scrolled, transformed): click, double click, keys, text, edit chords, line keys, drag, capture, wheel, cursor, hover, select popups, copy, cut, order; select popups, copy and cut in same-origin frames too')
  return 0
}

app.whenReady().then(main).then(
  (code) => {
    rmSync(userData, { recursive: true, force: true })
    app.exit(code)
  },
  (err) => {
    console.error(err)
    app.exit(1)
  }
)
