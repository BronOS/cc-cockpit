// Preload bridge. The renderer is sandboxed with contextIsolation, so this is the only way it
// reaches main, and it exposes exactly two functions: `invoke` (request/response) and `on`
// (main -> renderer events). No `ipcRenderer`, no Node, no generic send: everything a renderer
// can ask for is a handler main registered through src/main/ipc/router.ts, which checks who is
// asking.
//
// Only the channels declared in src/shared/ipc.ts pass. The router's sender check stays the
// authority, but without this list any `ipcMain.handle` or `webContents.send` channel added
// outside the shared contract would be reachable from the page with no review point.
import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  PANEL_PORT_CHANNEL,
  PANEL_PORT_MESSAGE,
  type CockpitApi
} from '../shared/ipc'

const invokeChannels: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const eventChannels: ReadonlySet<string> = new Set(EVENT_CHANNELS)

const api: CockpitApi = {
  invoke: (channel, ...payload) => {
    // Typed callers cannot pass anything else, but the renderer is untrusted JS: check the
    // channel here (a non-string one included) instead of letting Electron coerce it.
    if (typeof channel !== 'string' || !invokeChannels.has(channel)) {
      return Promise.reject(new Error('invalid channel'))
    }
    return ipcRenderer.invoke(channel, ...payload)
  },
  on: (channel, listener) => {
    if (typeof channel !== 'string' || !eventChannels.has(channel)) {
      throw new Error('invalid channel')
    }
    // Hand the listener the payload only: the IpcRendererEvent carries `sender` (ipcRenderer
    // itself), which would give the page the raw IPC object this bridge exists to hide.
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      (listener as (payload: unknown) => void)(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('cockpit', api)

// Panel ports (Task 28). A MessagePort cannot cross contextBridge, so the one main posts for a
// panel (`panels.connect`, src/main/plugins/panel-ports.ts) is re-posted into the page's own
// window with the port in the transfer list (Electron's documented way into an isolated main
// world). The page takes it only from `event.source === window`: a panel iframe posting to its
// parent is the iframe's window, so a page cannot slip in a port of its own. Only the two fields
// the page needs are passed on, as checked types; anything else closes the port.
ipcRenderer.on(PANEL_PORT_CHANNEL, (event, payload: unknown) => {
  const [port, ...extra] = event.ports
  for (const p of extra) p.close()
  if (!port) return
  const { panelKey, nonce } = (payload ?? {}) as { panelKey?: unknown; nonce?: unknown }
  if (typeof panelKey !== 'string' || typeof nonce !== 'number') {
    port.close()
    return
  }
  // globalThis is the page's window here; typed by hand because this file also compiles without
  // the DOM lib (tsconfig.node.json).
  const page = globalThis as unknown as { postMessage(message: unknown, target: string, transfer: unknown[]): void }
  page.postMessage({ type: PANEL_PORT_MESSAGE, panelKey, nonce }, '*', [port])
})
