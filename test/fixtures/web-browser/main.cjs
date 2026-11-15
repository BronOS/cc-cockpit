// A plain browser for the web access e2e specs (test/e2e/web-fixtures.ts): Electron's own Chromium
// with one window and nothing of the app in it. No preload, no node integration, a sandboxed
// renderer (the `sandbox` web preference), a profile of its own (cookies included) and HOME in a
// temp dir: to the gateway it is any other Chromium, and nothing it does can reach the app's
// session or the developer's browser profile.
//
// The OS-level Chromium sandbox is off on Linux: Playwright's electron.launch adds `--no-sandbox`
// unless `chromiumSandbox: true`, and the spec leaves it so. Turning it on needs a SUID
// chrome-sandbox or unprivileged user namespaces (restricted by AppArmor on recent Ubuntu), and the
// page it would guard is the local gateway's own web shell, not the open web.
//
// Why not Playwright's bundled Chromium: it is a separate download (`npx playwright install`) that
// the suite does not otherwise need, and Electron's Chromium is already here, on every machine
// that can run the suite at all.
//
// argv (after the script): <profile dir> <url>.
const { app, BrowserWindow } = require('electron')
const { join } = require('node:path')

const [profile, url] = process.argv.slice(-2)
if (!profile || !url) throw new Error('usage: electron main.cjs <profile dir> <url>')
// Before ready: the whole profile (cookies, storage, cache) lives in the spec's temp dir.
app.setPath('userData', profile)

app.on('window-all-closed', () => app.quit())

void app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    // Not resizable: a tiling window manager (Hyprland) floats a fixed-size window instead of tiling it
    // beside the desktop's window and halving that, which would auto-zoom the split view there (D5, D25).
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  // A new tab the page opens (window.open, a target=_blank link) is recorded for the spec to read
  // (`app.evaluate(() => globalThis.__opened)`) and never opened: no window, no request leaves.
  globalThis.__opened = []
  win.webContents.setWindowOpenHandler(({ url: opened }) => {
    globalThis.__opened.push(opened)
    return { action: 'deny' }
  })
  // The web shell holds an unload while a page tab has unsaved text (web/main.tsx beforeunload).
  // Electron would cancel the close silently and the spec's teardown would wait for ever, so this
  // test browser always lets the page go; specs check the hold with a dispatched event instead.
  win.webContents.on('will-prevent-unload', (event) => event.preventDefault())
  // A download the page starts (the download specs): saved under <profile>/downloads/<n>/<name> and
  // recorded for the spec (`app.evaluate(() => globalThis.__downloads)`), never to a dialog. Playwright
  // does not report an Electron session's downloads, so this is the fixture's own record: the url, the
  // name the browser chose, the end state and where the bytes are.
  globalThis.__downloads = []
  win.webContents.session.on('will-download', (_event, item) => {
    const rec = { url: item.getURL(), name: item.getFilename(), state: 'progressing', path: '' }
    rec.path = join(profile, 'downloads', String(globalThis.__downloads.length), rec.name)
    globalThis.__downloads.push(rec)
    item.setSavePath(rec.path)
    item.once('done', (_e, state) => {
      rec.state = state
    })
  })
  void win.loadURL(url)
})
