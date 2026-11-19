// A browser's input into a streamed (off-screen) page, under Electron: a unit test with a fake view
// proves nothing about Chromium's input routing. Bundles the real OffscreenWebviewFactory
// (src/main/webview/electron-offscreen-webview.ts, with its PageInputRouter, page-input.ts) and
// WebviewInput (webview-input.ts) with esbuild, makes a view the way server mode does (its page
// protocol attached and auto-attaching frames, webview-hardening.ts), and loads a top page on
// 127.0.0.1 (scrollable) holding a cross-site iframe on localhost (A, scrollable) that holds another
// on [::1] (B), and a second localhost iframe at scale(0.5) (T): three sites, each frame its own
// process with site isolation (checked). Each document logs the trusted events it gets.
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
// there); a scrolled top page and a scrolled A (B under both); Tab from the top field into A and
// plain keys, a text and an edit chord landing there; every allow-listed key against the raw road
// (the page's key, code and keyCode, and what it types); a prevented plain key down typing nothing;
// undo, redo, a prevented chord, one undo per group (the top document, as before); the editing
// keys (Backspace, Delete, arrows, Shift/Option/Cmd+arrows, Home, End, Option/Cmd+Backspace); the
// Mac line keys in a textarea with the caret mid-line (Cmd+Left/Right/Up/Down, with Shift,
// Cmd+Backspace) and a Cmd+Shift+Left in A; order: rounds of clicks into A, the top, B and T with
// keys and texts after each, nothing awaited, and the top document's "abc" é Ctrl+A "x" and
// "abc" é "d". Printed, never failures: Ctrl+E and Ctrl+K (a Mac field's Emacs keys, not mapped),
// and the router's cost per pointer event in each document.
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

/** One page for every document, by role: the top holds A and T, A holds B. */
function page(port, role) {
  const frames =
    role === 'top'
      ? `<iframe id="A" src="http://localhost:${port}/?role=frame"></iframe><iframe id="T" src="http://localhost:${port}/?role=xform"></iframe>`
      : role === 'frame'
        ? `<iframe id="B" src="http://[::1]:${port}/?role=nested"></iframe>`
        : ''
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0} body{height:3000px} input{position:absolute;left:10px;top:10px;width:200px;height:30px;font:16px monospace}
#box{position:absolute;left:10px;top:50px;width:200px;height:60px;overflow:auto} #box div{height:2000px}
#l{position:absolute;left:250px;top:10px} textarea{position:absolute;left:300px;top:10px;width:250px;height:80px;font:12px monospace;white-space:pre}
iframe{position:absolute;border:0} #A{left:0;top:200px;width:600px;height:300px} #T{left:650px;top:200px;width:300px;height:300px;transform:scale(0.5);transform-origin:0 0}
#B{left:300px;top:100px;width:280px;height:180px}</style>
<input id="i" autocomplete="off" value=""><div id="box"><div>scroll</div></div><a id="l" href="#x">a link</a><textarea id="t"></textarea>${frames}
<script>
  window.__log = []
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
  window.__state = () => ({ value: i.value, sel: [i.selectionStart, i.selectionEnd], text: ta.value, tsel: [ta.selectionStart, ta.selectionEnd], active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), scroll: document.getElementById('box').scrollTop, log: __log.splice(0) })
  window.__reset = () => { i.value = ''; ta.value = ''; document.getElementById('box').scrollTop = 0; scrollTo(0, 0); __log.length = 0; __prevent = false; __preventPlain = ''; if (document.activeElement) document.activeElement.blur() }
  window.__caret = (value, start, end) => { i.value = value; i.focus(); i.setSelectionRange(start, end === undefined ? start : end) }
  window.__tcaret = (value, start, end) => { ta.value = value; ta.focus(); ta.setSelectionRange(start, end === undefined ? start : end) }
</script>`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)])

/** Each document's own points (its CSS px): the field, the box, the link. */
const LOCAL = { input: [20, 25], box: [60, 80], link: [260, 18] }
/** Where a document's own point is in the top page's viewport (top page scrolled by `scroll`, A by `frameScroll`). */
function toTop(doc, [x, y], { scroll = 0, frameScroll = 0 } = {}) {
  if (doc === 'top') return [x, y - scroll]
  if (doc === 'frame') return [x, 200 + y - frameScroll - scroll]
  if (doc === 'nested') return [300 + x, 200 + 100 + y - frameScroll - scroll]
  return [650 + x / 2, 200 + y / 2 - scroll] // xform: scale(0.5) from its top left
}
/** The protocol's modifier bits. */
const BITS = { alt: 1, control: 2, meta: 4, shift: 8 }

async function main() {
  const { OffscreenWebviewFactory, WebviewInput, toElectronEvents } = await loadModules()
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(page(server.address().port, new URL(req.url, 'http://x').searchParams.get('role') ?? 'top'))
  })
  await new Promise((done) => server.listen(0, '::', done))
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
    gone: () => logs.push('gone')
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
    if (docs.top && docs.frame && docs.nested && docs.xform && childSession) break
    await sleep(100)
  }
  const failures = []
  if (!docs.frame || !docs.nested || !docs.xform || !childSession) failures.push('a frame never loaded or was never attached')
  const pids = Object.fromEntries(Object.entries(docs).map(([k, f]) => [k, f.osProcessId]))
  if (new Set([pids.top, pids.frame, pids.nested]).size !== 3 || pids.xform === pids.top) failures.push(`the frames share processes (no site isolation): ${JSON.stringify(pids)}`)
  console.log(`processes: ${JSON.stringify(pids)}; protocol attached: ${wc.debugger.isAttached()}`)
  if (failures.length) {
    console.log('\nFAIL:\n  ' + failures.join('\n  '))
    return 1
  }

  const js = (doc, code) => within(docs[doc].executeJavaScript(code), 3000, 'unresponsive')
  const state = (doc) => js(doc, '__state()')
  const DOCS = ['top', 'frame', 'nested', 'xform']
  const reset = async () => {
    for (const d of DOCS) await js(d, '__reset()')
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
    if (ok === 'MISS') failures.push(`view: key ${label} gave ${JSON.stringify(got)}, a Mac's field gives ${JSON.stringify(expectedHere)}`)
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

  if (logs.length) console.log('log:', JSON.stringify(logs))
  view.destroy()
  owner.destroy()
  server.close()
  if (failures.length) {
    console.log('\nFAIL:\n  ' + failures.join('\n  '))
    return 1
  }
  console.log('\nOK: the view road works in the top document and in cross-site frames (nested, scrolled, transformed): click, double click, keys, text, edit chords, line keys, drag, capture, wheel, cursor, hover, order')
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
