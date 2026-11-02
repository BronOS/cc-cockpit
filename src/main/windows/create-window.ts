import { join } from 'node:path'
import { BrowserWindow, nativeTheme, type BrowserWindowConstructorOptions } from 'electron'
import type { RendererLocation } from '../ipc/router'
import { BUILTIN_THEMES } from '../themes/theme-service'
import { sameOrigin } from './frame-origin'

/** The built-in theme's --cc-bg for the OS appearance (the window's colour before the page paints). */
function builtinBackground(kind: 'light' | 'dark'): string {
  return BUILTIN_THEMES.find((t) => t.kind === kind)?.vars['--cc-bg'] ?? (kind === 'dark' ? '#1a1817' : '#faf8f6')
}

/**
 * The only place a BrowserWindow is constructed. Every window (project picker, project windows)
 * goes through here so the security posture cannot be forgotten for one of them:
 * - contextIsolation + sandbox + no nodeIntegration: the renderer is untrusted UI code that
 *   embeds sandboxed plugin iframes; it talks to main only through the preload bridge.
 * - navigation away from the app page is denied and window.open is denied: a link inside a
 *   terminal or a plugin panel must never turn the shell window into a browser. Opening a link in
 *   the system browser is an explicit request to main (later tasks), not a navigation.
 */
export function createWindow(options: BrowserWindowConstructorOptions = {}): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    // Painted before the renderer has applied the theme (it asks main first), so a dark-OS user
    // does not see a white window flash. Read from the built-in of the OS kind, so a retuned
    // --cc-bg cannot leave a differently coloured frame showing for the first paint.
    backgroundColor: builtinBackground(nativeTheme.shouldUseDarkColors ? 'dark' : 'light'),
    ...options,
    webPreferences: {
      // Caller-supplied webPreferences are merged first and then the security flags are forced,
      // so a caller can add (e.g. a partition) but never weaken them. Every flag that widens the
      // renderer's reach is pinned too, not just the three core ones.
      ...options.webPreferences,
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      experimentalFeatures: false
    }
  })

  // Linux and Windows draw the application menu as a bar inside the window, above a page that already
  // has its own top bar. Hidden, not removed: its accelerators (copy/paste, quit, Open Folder) keep
  // working. Not autoHideMenuBar: a lone Alt would then pop the bar up, and Alt belongs to the
  // terminal. A no-op on macOS, where the menu lives in the system's bar.
  win.setMenuBarVisibility(false)

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  // Subframes (plugin panels and overlays): the shell page's `frame-src cc-overlay: cc-plugin:`
  // keeps them off the network, but it is scheme-wide, so a panel page could navigate ITSELF to
  // another plugin's page; PluginFrame would then hand that page the first plugin's host port on
  // load. A frame may only move within its own origin (its own pages, a reload); the shell page
  // (the only top frame here) setting an iframe's src is what loads a page into it.
  win.webContents.on('will-frame-navigate', (event) => {
    if (event.isMainFrame) return
    if (event.initiator && event.initiator.parent === null) return
    if (!sameOrigin(event.frame?.url, event.url)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.once('ready-to-show', () => win.show())
  return win
}

/**
 * Where the shell UI comes from: the Vite dev server under `npm run dev`, the built file
 * otherwise. The IPC router pins senders to this same location (appPageMatcher).
 */
export function rendererLocation(): RendererLocation {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return { kind: 'url', url: devUrl }
  return { kind: 'file', path: join(__dirname, '../renderer/index.html') }
}

/** Loads the shell UI from `rendererLocation()`. */
export async function loadRenderer(win: BrowserWindow): Promise<void> {
  const location = rendererLocation()
  if (location.kind === 'url') {
    await win.loadURL(location.url)
  } else {
    await win.loadFile(location.path)
  }
}
