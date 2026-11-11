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

const [profile, url] = process.argv.slice(-2)
if (!profile || !url) throw new Error('usage: electron main.cjs <profile dir> <url>')
// Before ready: the whole profile (cookies, storage, cache) lives in the spec's temp dir.
app.setPath('userData', profile)

app.on('window-all-closed', () => app.quit())

void app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  void win.loadURL(url)
})
