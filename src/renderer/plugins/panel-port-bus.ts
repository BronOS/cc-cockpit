// Panel ports arriving from main. The preload re-posts each one into this window as
// `{ type: PANEL_PORT_MESSAGE, panelKey, nonce }` with the port transferred (src/preload/index.ts);
// this module takes them off the window and hands each to the panel that asked for it with that
// nonce (PluginPanel). A port nobody waits for (the panel reloaded or went away meanwhile) is
// closed, so the host's end hears the close.
import { PANEL_PORT_MESSAGE } from '../../shared/ipc'

type Waiter = { nonce: number; take: (port: MessagePort) => void }

const waiting = new Map<string, Waiter>()
let nextNonce = 1
let listening = false

function onMessage(event: MessageEvent): void {
  // Only the preload posts these, into its own window. A panel iframe posting to its parent has
  // the iframe's window as source and is ignored here, port and all.
  if (event.source !== window) return
  const data = event.data as { type?: unknown; panelKey?: unknown; nonce?: unknown } | null
  if (data?.type !== PANEL_PORT_MESSAGE) return
  const [port] = event.ports
  if (!port) return
  const waiter = typeof data.panelKey === 'string' ? waiting.get(data.panelKey) : undefined
  if (!waiter || waiter.nonce !== data.nonce) {
    port.close()
    return
  }
  waiting.delete(data.panelKey as string)
  waiter.take(port)
}

/**
 * Ask main for a port for `panelKey`; `take` gets it if it arrives while this is still the
 * latest request for that panel. Returns the cancel (the panel's page unloaded).
 */
export function requestPanelPort(panelKey: string, take: (port: MessagePort) => void): () => void {
  if (!listening) {
    listening = true
    window.addEventListener('message', onMessage)
  }
  const nonce = nextNonce++
  const waiter: Waiter = { nonce, take }
  waiting.set(panelKey, waiter)
  window.cockpit
    .invoke('panels.connect', { panelKey, nonce })
    .then((ok) => {
      // Refused (the plugin is not running yet): no port follows; `panels.reload` comes when it is.
      if (!ok && waiting.get(panelKey) === waiter) waiting.delete(panelKey)
    })
    .catch((err: unknown) => {
      if (waiting.get(panelKey) === waiter) waiting.delete(panelKey)
      console.warn(`panels.connect ${panelKey} failed`, err)
    })
  return () => {
    if (waiting.get(panelKey) === waiter) waiting.delete(panelKey)
  }
}
