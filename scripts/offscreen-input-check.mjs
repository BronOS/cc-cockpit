// A browser's input into a streamed (off-screen) page, under Electron: a unit test with a fake view
// proves nothing about Chromium's input routing. Bundles the real OffscreenWebviewFactory
// (src/main/webview/electron-offscreen-webview.ts) and WebviewInput (webview-input.ts) with
// esbuild, makes a view the way server mode does (its page protocol attached and auto-attaching
// frames, webview-hardening.ts), and loads a top page on 127.0.0.1 holding a cross-site iframe on
// localhost (its own process with site isolation, which the check verifies). Each document logs
// the trusted events it gets.
//
// Roads, each into the top document and the iframe:
//   raw       `webContents.sendInputEvent`;
//   protocol  `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` on the
//             page's own DevTools session (no sessionId);
//   child     the same commands on the iframe's own session (auto-attached), in its coordinates;
//   view      what main does: WebviewInput.accept / acceptText (the lane, edit chords) into the
//             view's sendInput, insertText and editCommand.
// For each: a click focuses a field, keys and a committed text type into it, Ctrl+A and Cmd+A
// select all, a drag selects, a wheel scrolls a box, a pointer over a link gives the hand cursor.
//
// Found on macOS (Electron 45.1.0, 2026-11-19, GPU off and on): no pointer event of the raw,
// protocol or view road reaches the iframe (the top document gets it, its target the IFRAME
// element), so a click never focuses its field; only the child road reaches it. Those rows are
// printed as the known gap (docs/backlog/streamed-clicks-miss-cross-site-iframes.md), never a
// failure. Keys differ: with focus in the iframe (by Tab, or the child road's click), the page
// session's key events, edit chords and text land there, the raw road's keys on the top body.
//
// Then, through the view road in the top document: undo, redo (Cmd+Shift+Z, Ctrl+Y), a page that
// prevents the key down (no command runs), one Ctrl+Z undoing one typing group, not two (a server
// whose own key handling also ran the chord would undo twice); the editing keys (Backspace,
// Delete, arrows, Shift/Option/Cmd/Ctrl+arrows, Home, End, Option/Cmd/Ctrl+Backspace), printed
// with what a Mac's text field does (probes: a miss is reported, not a failure); with focus in the
// iframe's field (by the child road, then by Tab), where a plain key, an edit chord and a text
// land; and order: "abc", a text, Ctrl+A, "x" and "abc", a text, "d", ROUNDS times each,
// nothing awaited.
//
//   node scripts/offscreen-input-check.mjs [rounds]
//
// Exit 0 when the view road passes in the top document (click, keys, text, edit chords, drag,
// wheel, cursor, undo and redo, the prevented key down, one undo, order).
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
const KILL_AFTER_MS = 300_000

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
        "export { WebviewInput } from './src/main/webview/webview-input'",
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

/** One page for both documents; the iframe only on the top one (127.0.0.1). */
function page(port) {
  return `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0} input{position:absolute;left:10px;top:10px;width:200px;height:30px}
#box{position:absolute;left:10px;top:50px;width:200px;height:60px;overflow:auto} #box div{height:2000px}
a{position:absolute;left:250px;top:10px} iframe{position:absolute;left:0;top:200px;width:600px;height:300px;border:0}</style>
<input id="i" autocomplete="off" value=""><div id="box"><div>scroll</div></div><a href="#x">a link</a>
<script>
  window.__log = []
  window.__prevent = false
  for (const t of ['mousedown', 'click', 'keydown', 'wheel', 'focusin']) {
    document.addEventListener(t, (e) => {
      if (!e.isTrusted) return
      __log.push(t + ':' + (e.target.id || e.target.tagName) + (t === 'keydown' ? ':' + e.key + (e.metaKey ? '+M' : '') + (e.ctrlKey ? '+C' : '') + (e.shiftKey ? '+S' : '') : ''))
      if (t === 'keydown' && __prevent && (e.metaKey || e.ctrlKey)) e.preventDefault()
    }, true)
  }
  const i = document.getElementById('i')
  window.__state = () => ({ value: i.value, sel: [i.selectionStart, i.selectionEnd], active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), scroll: document.getElementById('box').scrollTop, log: __log.splice(0) })
  window.__reset = () => { i.value = ''; document.getElementById('box').scrollTop = 0; __log.length = 0; __prevent = false; if (document.activeElement) document.activeElement.blur() }
  window.__caret = (value, start, end) => { i.value = value; i.focus(); i.setSelectionRange(start, end === undefined ? start : end) }
  if (location.hostname === '127.0.0.1') {
    const fr = document.createElement('iframe')
    fr.src = 'http://localhost:${port}/'
    document.body.append(fr)
  }
</script>`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms, fallback) => Promise.race([p, sleep(ms).then(() => fallback)])

/** Points (top page CSS px): each document's input, box and link; the iframe sits at (0, 200). */
const IFRAME_TOP = 200
const AT = {
  top: { input: [20, 25], box: [60, 80], link: [260, 18] },
  frame: { input: [20, 25 + IFRAME_TOP], box: [60, 80 + IFRAME_TOP], link: [260, 18 + IFRAME_TOP] }
}
/** The protocol's modifier bits. */
const BITS = { alt: 1, control: 2, meta: 4, shift: 8 }

async function main() {
  const { OffscreenWebviewFactory, WebviewInput } = await loadModules()
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(page(server.address().port))
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
  let childSession
  wc.debugger.on('message', (_e, method, params) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') childSession = params.sessionId
  })
  /** The page's last cursor type (each check clears it first). */
  let cursor
  view.setSink({ paint: () => {}, cursor: (type) => (cursor = type) })
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 })
  view.setVisible(true)
  await view.load(`http://127.0.0.1:${port}/`)

  const docs = {}
  for (let i = 0; i < 50; i++) {
    for (const fr of wc.mainFrame.framesInSubtree) {
      if (fr.url === `http://127.0.0.1:${port}/`) docs.top = fr
      if (fr.url === `http://localhost:${port}/`) docs.frame = fr
    }
    if (docs.top && docs.frame && childSession) break
    await sleep(100)
  }
  const failures = []
  if (!docs.frame || !childSession) failures.push('the iframe never loaded or was never attached')
  else if (docs.frame.osProcessId === docs.top.osProcessId) failures.push('the iframe shares the top process (no site isolation): proves nothing')
  console.log(`processes: top ${docs.top.osProcessId}, iframe ${docs.frame?.osProcessId}; protocol attached: ${wc.debugger.isAttached()}`)

  const js = (doc, code) => within(docs[doc].executeJavaScript(code), 3000, 'unresponsive')
  const state = (doc) => js(doc, '__state()')
  const reset = async () => {
    for (const d of ['top', 'frame']) await js(d, '__reset()')
    await sleep(80)
  }
  const settle = () => sleep(120)

  // The view road: main's own gate and lane over the real view, as index.ts wires them (one
  // viewer, its bucket refilled on every call so no round is cut by the rate cap).
  let t = 0
  const PANEL = { windowId: owner.id, pluginId: 'check', panelId: 'view' }
  const target = {
    size: () => view.size(),
    send: (events) => view.sendInput(events),
    insertText: (text) => view.insertText(text),
    editCommand: (input) => view.editCommand(input)
  }
  const input = new WebviewInput({ isViewer: () => true, claimOwner: () => {}, target: () => target, now: () => (t += 10_000) })
  const viewKey = (type, key, modifiers = []) => input.accept(PANEL, 'web:1', [{ kind: 'key', type, key, modifiers }])
  const viewPress = (key, modifiers = []) => {
    viewKey('down', key, modifiers)
    viewKey('up', key, modifiers)
  }

  // One shape for every road: mouse (move|down|up, x, y, held), wheel, key (down|up, key, mods), text.
  const protocolRoad = (sessionId, dy) => {
    const send = (method, params) => (sessionId ? wc.debugger.sendCommand(method, params, sessionId) : wc.debugger.sendCommand(method, params)).catch((e) => console.log(`${method}: ${e.message}`))
    return {
      mouse: (type, x, y, held = false) => {
        const kind = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[type]
        void send('Input.dispatchMouseEvent', { type: kind, x, y: y - dy, button: type === 'move' && !held ? 'none' : 'left', buttons: held || type === 'down' ? 1 : 0, clickCount: type === 'move' ? 0 : 1 })
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
      mouse: (type, x, y, held = false) => {
        const kind = { move: 'mouseMove', down: 'mouseDown', up: 'mouseUp' }[type]
        wc.sendInputEvent({ type: kind, x, y, button: 'left', clickCount: 1, modifiers: held ? ['leftbuttondown'] : [] })
      },
      wheel: (x, y, deltaY) => wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -deltaY }),
      key: (type, key, modifiers = []) => {
        wc.sendInputEvent({ type: type === 'down' ? 'keyDown' : 'keyUp', keyCode: key, modifiers })
        if (type === 'down' && modifiers.length === 0) wc.sendInputEvent({ type: 'char', keyCode: key })
      },
      text: (text) => wc.insertText(text)
    },
    protocol: protocolRoad(undefined, 0),
    child: protocolRoad(childSession, IFRAME_TOP),
    view: {
      mouse: (type, x, y, held = false) =>
        input.accept(PANEL, 'web:1', [
          type === 'move'
            ? { kind: 'pointer', type: 'move', x, y, modifiers: held ? ['leftbuttondown'] : [] }
            : { kind: 'pointer', type, x, y, button: 'left', clickCount: 1 }
        ]),
      wheel: (x, y, deltaY) => input.accept(PANEL, 'web:1', [{ kind: 'wheel', x, y, deltaX: 0, deltaY }]),
      key: viewKey,
      text: (text) => input.acceptText(PANEL, 'web:1', text)
    }
  }

  // --- every road into both documents ---
  const results = {}
  for (const [name, road] of Object.entries(roads)) {
    for (const doc of ['top', 'frame']) {
      if (name === 'child' && doc === 'top') continue
      const at = AT[doc]
      const r = {}
      await reset()
      road.mouse('move', ...at.input)
      road.mouse('down', ...at.input)
      road.mouse('up', ...at.input)
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
      const [ix, iy] = at.input
      road.mouse('move', ix - 8, iy)
      road.mouse('down', ix - 8, iy)
      road.mouse('move', ix + 60, iy, true)
      road.mouse('move', ix + 150, iy, true)
      road.mouse('up', ix + 150, iy)
      await settle()
      const dragged = await state(doc)
      r.drag = dragged.sel[1] - dragged.sel[0]
      road.mouse('move', ...at.box)
      road.wheel(...at.box, 120)
      await sleep(400)
      r.wheel = (await state(doc)).scroll
      cursor = ''
      road.mouse('move', ...at.link)
      await settle()
      r.cursor = cursor
      road.mouse('move', 700, 150)
      await settle()
      results[`${name} ${doc}`] = r
      const gap = doc === 'frame' && name !== 'child' && !r.click ? '   (misses the cross-site iframe)' : ''
      console.log(`${name.padEnd(8)} ${doc.padEnd(5)} ${JSON.stringify(r)}${gap}`)
    }
  }
  const viewTop = results['view top']
  const want = (ok, text) => ok || failures.push(text)
  want(viewTop.click, 'view top: the click did not reach the field')
  want(viewTop.typed === 'abé', `view top: typed ${JSON.stringify(viewTop.typed)}, not "abé"`)
  want(viewTop.selectAll.control && viewTop.selectAll.meta, `view top: select all ${JSON.stringify(viewTop.selectAll)}`)
  want(viewTop.drag > 3, `view top: a drag selected ${viewTop.drag} characters`)
  want(viewTop.wheel > 0, 'view top: the wheel did not scroll the box')
  want(viewTop.cursor === 'hand', `view top: the cursor over the link was ${JSON.stringify(viewTop.cursor)}`)

  // --- S6 through the view road (top document) ---
  const focusTop = async () => {
    await reset()
    roads.view.mouse('down', ...AT.top.input)
    roads.view.mouse('up', ...AT.top.input)
    await settle()
  }
  const typeView = (text) => {
    for (const ch of text) viewPress(ch)
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
  want(prevented.sel[0] === 3 && preventedUndo === 'abc' && sawKeys.includes('keydown:i:a+M'), 'view: a prevented key down still ran its command (or the page never saw it)')

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

  // --- editing keys through the view road (probes: what a Mac's text field does) ---
  const L = 'one two three'
  const keyProbes = [
    ['Backspace', [], 13, 13, 'value', 'one two thre'],
    ['Delete', [], 0, 0, 'value', 'ne two three'],
    ['ArrowLeft', [], 13, 13, 'caret', 12],
    ['ArrowRight', [], 0, 0, 'caret', 1],
    ['ArrowLeft', ['shift'], 13, 13, 'sel', '12-13'],
    ['Home', [], 13, 13, 'caret', 0],
    ['End', [], 0, 0, 'caret', 13],
    ['ArrowLeft', ['alt'], 13, 13, 'caret', 8],
    ['ArrowRight', ['alt'], 0, 0, 'caret', 3],
    ['ArrowLeft', ['meta'], 13, 13, 'caret', 0],
    ['ArrowRight', ['meta'], 0, 0, 'caret', 13],
    ['ArrowLeft', ['meta', 'shift'], 13, 13, 'sel', '0-13'],
    ['ArrowLeft', ['control'], 13, 13, 'caret', 'Linux: 8'],
    ['Backspace', ['alt'], 13, 13, 'value', 'one two '],
    ['Backspace', ['meta'], 13, 13, 'value', ''],
    ['Backspace', ['control'], 13, 13, 'value', 'Linux: one two ']
  ]
  const misses = []
  for (const [key, mods, start, , what, expected] of keyProbes) {
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
    if (ok === 'MISS') misses.push(`${label}: ${JSON.stringify(got)}, a Mac's field gives ${JSON.stringify(expectedHere)}`)
    console.log(`  key ${label.padEnd(22)} ${what} ${JSON.stringify(got)}${expectedHere === undefined ? '' : ` (want ${JSON.stringify(expectedHere)})`} ${ok}`)
  }
  if (misses.length) console.log(`editing keys (probe, not failures): ${misses.length} miss(es):\n    ${misses.join('\n    ')}`)

  // --- focus in the iframe's field (by the child road): where the view road's keys land ---
  await reset()
  roads.child.mouse('down', ...AT.frame.input)
  roads.child.mouse('up', ...AT.frame.input)
  await settle()
  roads.child.text('in frame')
  await settle()
  await state('top')
  viewPress('q')
  viewPress('a', ['control'])
  await settle()
  const topAfter = await state('top')
  const frameAfter = await state('frame')
  console.log(`focus in the iframe: a view-road "q" and Ctrl+A → iframe ${JSON.stringify({ value: frameAfter.value, sel: frameAfter.sel, keys: frameAfter.log.filter((l) => l.startsWith('keydown')) })}, top ${JSON.stringify({ value: topAfter.value, keys: topAfter.log.filter((l) => l.startsWith('keydown')) })}`)

  // --- Tab from the top field into the iframe (a person's only way in): where keys go after ---
  await focusTop()
  for (let n = 0; n < 4 && (await state('top')).active !== 'IFRAME'; n++) {
    viewPress('Tab')
    await settle()
  }
  const tabTop = await state('top')
  const tabFrame = await state('frame')
  viewPress('q')
  await settle()
  roads.protocol.key('down', 'w')
  roads.protocol.key('up', 'w')
  await settle()
  await roads.view.text('é')
  await settle()
  const tabTop2 = await state('top')
  const tabFrame2 = await state('frame')
  console.log(
    `Tab from the top field into the iframe: top active ${JSON.stringify(tabTop.active)}, iframe active ${JSON.stringify(tabFrame.active)}; then a view-road "q", a page-session protocol "w" and a view-road text "é" → iframe ${JSON.stringify(tabFrame2.value)} ${JSON.stringify(tabFrame2.log.filter((l) => l.startsWith('keydown')))}, top ${JSON.stringify(tabTop2.value)} ${JSON.stringify(tabTop2.log.filter((l) => l.startsWith('keydown')))}`
  )

  // --- order through the view road (top document), nothing awaited ---
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
  console.log(`order (view road, ${ROUNDS} rounds): "abc" é Ctrl+A "x" wrong ${wrongSelect}, "abc" é "d" wrong ${wrongText} ${samples.length ? JSON.stringify(samples) : ''}`)
  want(wrongSelect === 0 && wrongText === 0, `order: ${wrongSelect} + ${wrongText} wrong`)

  if (logs.length) console.log('log:', JSON.stringify(logs))
  view.destroy()
  owner.destroy()
  server.close()
  if (failures.length) {
    console.log('\nFAIL:\n  ' + failures.join('\n  '))
    return 1
  }
  console.log('\nOK: the view road works in the top document (click, keys, text, edit chords, drag, wheel, cursor, undo, redo, a prevented key down, order)')
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
