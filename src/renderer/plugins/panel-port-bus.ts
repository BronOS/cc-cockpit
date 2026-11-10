// Panel ports arriving from main. The preload re-posts each one into this window as
// `{ type: PANEL_PORT_MESSAGE, panelKey, nonce }` with the port transferred (src/preload/index.ts);
// this module takes them off the window and hands each to the panel that asked for it with that
// nonce (PluginPanel; a slot frame, SlotFrame, under its `@slot/<id>` key). A port nobody waits for (the panel reloaded or went away meanwhile) is
// closed, so the host's end hears the close. The web shell has no preload: its ports come from the
// socket relay (web/port-relay.ts) through `deliverPanelPort`, under the same keys and nonces.
import { PANEL_PORT_MESSAGE } from '../../shared/ipc'
import type { SettingsPageScope } from '../../shared/manifest'
import { settingsPagePortKey } from '../../shared/settings-page'
import { slotPortKey } from '../../shared/slots'

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
  if (!deliverPanelPort(data.panelKey, data.nonce, port)) port.close()
}

/**
 * Hand `port` to the request waiting for `panelKey` with `nonce`; false (the caller closes it) when
 * none does. The preload's posts come through `onMessage`; the web shell's socket relay
 * (web/port-relay.ts, main's `port.open`) calls this directly.
 */
export function deliverPanelPort(panelKey: unknown, nonce: unknown, port: MessagePort): boolean {
  const waiter = typeof panelKey === 'string' ? waiting.get(panelKey) : undefined
  if (!waiter || waiter.nonce !== nonce) return false
  waiting.delete(panelKey as string)
  waiter.take(port)
  return true
}

/**
 * Ask main for a port for `panelKey`; `take` gets it if it arrives while this is still the
 * latest request for that panel. Returns the cancel (the panel's page unloaded).
 */
export function requestPanelPort(panelKey: string, take: (port: MessagePort) => void): () => void {
  return request(panelKey, take, (nonce) => window.cockpit.invoke('panels.connect', { panelKey, nonce }))
}

/**
 * The same for a slot frame (design-next §2): main hands one end to the slot's PROVIDER and posts
 * this one on the panels' channel under `@slot/<frameId>` (slotPortKey), so it lands here like a
 * panel's. `slots.connect` is refused (false, no port) for a frame main no longer draws.
 */
export function requestSlotPort(frameId: string, take: (port: MessagePort) => void): () => void {
  return request(slotPortKey(frameId), take, (nonce) => window.cockpit.invoke('slots.connect', { frameId, nonce }))
}

/**
 * The same for a plugin's html settings page (design-next §5.4): main hands one end to that plugin's
 * backend in this window's host and posts this one under `@settings/<pluginId>` (settingsPagePortKey).
 * Refused (false, no port) while the plugin does not run here.
 */
export function requestSettingsPagePort(pluginId: string, scope: SettingsPageScope, take: (port: MessagePort) => void): () => void {
  return request(settingsPagePortKey(pluginId), take, (nonce) => window.cockpit.invoke('settingsPage.connect', { pluginId, scope, nonce }))
}

function request(key: string, take: (port: MessagePort) => void, connect: (nonce: number) => Promise<boolean>): () => void {
  if (!listening) {
    listening = true
    window.addEventListener('message', onMessage)
  }
  const nonce = nextNonce++
  const waiter: Waiter = { nonce, take }
  waiting.set(key, waiter)
  connect(nonce)
    .then((ok) => {
      // Refused (the plugin is not running yet): no port follows; `panels.reload` comes when it is.
      if (!ok && waiting.get(key) === waiter) waiting.delete(key)
    })
    .catch((err: unknown) => {
      if (waiting.get(key) === waiter) waiting.delete(key)
      console.warn(`connecting ${key} failed`, err)
    })
  return () => {
    if (waiting.get(key) === waiter) waiting.delete(key)
  }
}
