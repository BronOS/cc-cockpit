// ctx.slots (design-next §2): the PROVIDER side of a slot, the plugin that draws a page in a place
// another plugin (or the app) laid out. A host plugin that places slots uses ctx.panels.slots
// (ctx/ui.ts); main decides who provides a type (the project's pick) and lays the frame out.
//
//   ctx.slots.onOpen(type, listener)   a frame of `type` opened (type declared in
//                                      `contributes.slots`); the listener gets a SlotInstance
//   ctx.slots.available(type)          would a placement of `type` draw now (main answers: the pick)
//
// Frames are the shell's: it mounts the provider's page and main hands this host one end of the
// frame's channel, tagged `{ "slotOpen": { pluginId, id, type, host, params? } }` with the port in
// its transfer list (src/main/plugins/host-manager.ts sendSlotPort, host/index.ts receivePort), so
// an open never arrives without its port. The frame ends with main's `slot.close { pluginId, id }`
// event, or when the page's end of the port closes (the iframe was removed or reloaded). Messages
// on the port follow the panel rules (host/ctx/ui.ts): ONE JSON string each, the same 1 MiB cap.
import type { Disposer, JsonValue, PluginContext, SlotInstance } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { MAX_SLOT_PARAMS_BYTES, SLOT_FRAME_ID_PATTERN, SLOT_TYPE_PATTERN, type SlotHost } from '../../shared/slots'
import { MAX_PANEL_MESSAGE_LENGTH, type PanelPort } from './ui'

type MessageListener = (message: JsonValue) => void

/**
 * What main sends with a slot frame's port. The params are the placement's (at most 4 KiB as
 * JSON), so the tag may be longer than a panel's; anything larger is not main's message.
 */
const MAX_SLOT_TAG_LENGTH = MAX_SLOT_PARAMS_BYTES * 4 + 1024

export interface SlotOpenTag {
  pluginId: string
  id: string
  type: string
  host: SlotHost
  params?: JsonValue
}

function hostOf(raw: unknown): SlotHost | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const h = raw as Record<string, unknown>
  if (h.kind === 'app' && h.place === 'top-bar') return { kind: 'app', place: 'top-bar' }
  if (h.kind === 'panel' && typeof h.pluginId === 'string' && typeof h.panelId === 'string') {
    return { kind: 'panel', pluginId: h.pluginId, panelId: h.panelId }
  }
  return undefined
}

/** main's port message `{ "slotOpen": {...} }` (sent with the port), or undefined for anything else. */
export function slotOpenTag(data: unknown): SlotOpenTag | undefined {
  if (typeof data !== 'string' || data.length > MAX_SLOT_TAG_LENGTH) return undefined
  try {
    const tag = (JSON.parse(data) as { slotOpen?: Record<string, unknown> } | null)?.slotOpen
    if (typeof tag !== 'object' || tag === null) return undefined
    const { pluginId, id, type, params } = tag
    const host = hostOf(tag.host)
    if (typeof pluginId !== 'string' || typeof id !== 'string' || !SLOT_FRAME_ID_PATTERN.test(id)) return undefined
    if (typeof type !== 'string' || !SLOT_TYPE_PATTERN.test(type) || !host) return undefined
    return { pluginId, id, type, host, ...(params !== undefined ? { params: params as JsonValue } : {}) }
  } catch {
    // Not one of main's port messages.
  }
  return undefined
}

/** One open frame of this host: the provider plugin's side. */
interface Frame {
  readonly pluginId: string
  readonly id: string
  readonly port: PanelPort
  readonly unsubscribe: () => void
  readonly messageListeners: Set<MessageListener>
  readonly closeListeners: Set<() => void>
  ended: boolean
}

/** The open slot frames and `onOpen` listeners of every plugin of one host. */
export class SlotHub {
  /** `<pluginId>/<type>` -> listeners. */
  private readonly openers = new Map<string, Set<(slot: SlotInstance) => void>>()
  /** `<pluginId>/<frameId>` -> frame. */
  private readonly frames = new Map<string, Frame>()

  constructor(private readonly log: (pluginId: string, message: string) => void) {}

  onOpen(pluginId: string, type: string, listener: (slot: SlotInstance) => void): Disposer {
    const key = `${pluginId}/${type}`
    const set = this.openers.get(key) ?? new Set<(slot: SlotInstance) => void>()
    // Wrapped: the same function registered twice is two registrations, each with its disposer.
    const entry = (slot: SlotInstance): void => listener(slot)
    set.add(entry)
    this.openers.set(key, set)
    return () => {
      set.delete(entry)
      if (set.size === 0 && this.openers.get(key) === set) this.openers.delete(key)
    }
  }

  /**
   * A frame opened (host/index.ts calls this for main's `slotOpen` port). The caller checked the
   * plugin runs here and declares the type. A frame with the same id is closed first (main does
   * that too, a reconnect of one id). `onPortClose` is how the adapter reports the page's end
   * going away; it ends only this frame, never a newer one with the same id.
   */
  open(tag: SlotOpenTag, port: PanelPort): void {
    const key = `${tag.pluginId}/${tag.id}`
    const old = this.frames.get(key)
    if (old) this.end(old)
    const messageListeners = new Set<MessageListener>()
    const closeListeners = new Set<() => void>()
    const frame: Frame = {
      pluginId: tag.pluginId,
      id: tag.id,
      port,
      unsubscribe: port.onMessage((raw) => this.receive(frame, raw)),
      messageListeners,
      closeListeners,
      ended: false
    }
    this.frames.set(key, frame)
    const slot = this.instanceOf(frame, tag)
    const listeners = [...(this.openers.get(`${tag.pluginId}/${tag.type}`) ?? [])]
    // An open that lands before activate() registered slots.onOpen (runtimes exist before activate
    // finishes) would leave the frame open with nobody serving it, silently: say so.
    if (listeners.length === 0) this.log(tag.pluginId, `a "${tag.type}" slot opened but no slots.onOpen listener is registered for it (yet)`)
    for (const listener of listeners) {
      try {
        listener(slot)
      } catch (err) {
        this.log(tag.pluginId, `a slots.onOpen listener threw: ${errorText(err)}`)
      }
    }
  }

  /** main's `slot.close { pluginId, id }`, or the page's port closing (`port`: only that frame's own). */
  close(pluginId: string, id: string, port?: PanelPort): void {
    const frame = this.frames.get(`${pluginId}/${id}`)
    if (frame && (port === undefined || frame.port === port)) this.end(frame)
  }

  /** The plugin is gone: its frames end (onClose runs) and its listeners drop. */
  removePlugin(pluginId: string): void {
    for (const frame of [...this.frames.values()]) if (frame.pluginId === pluginId) this.end(frame)
    const prefix = `${pluginId}/`
    for (const key of [...this.openers.keys()]) if (key.startsWith(prefix)) this.openers.delete(key)
  }

  /** How many frames of the plugin are open (tests). */
  openCount(pluginId: string): number {
    let n = 0
    for (const f of this.frames.values()) if (f.pluginId === pluginId) n++
    return n
  }

  private end(frame: Frame): void {
    if (frame.ended) return
    frame.ended = true
    const key = `${frame.pluginId}/${frame.id}`
    if (this.frames.get(key) === frame) this.frames.delete(key)
    frame.unsubscribe()
    try {
      frame.port.close()
    } catch {
      // Already closed on the other side.
    }
    const closers = [...frame.closeListeners]
    frame.messageListeners.clear()
    frame.closeListeners.clear()
    for (const listener of closers) {
      try {
        listener()
      } catch (err) {
        this.log(frame.pluginId, `a slot onClose listener threw: ${errorText(err)}`)
      }
    }
  }

  private instanceOf(frame: Frame, tag: SlotOpenTag): SlotInstance {
    const post = (message: JsonValue): void => {
      let text: string | undefined
      try {
        text = JSON.stringify(message)
      } catch (err) {
        throw new TypeError(`slot post: the message is not JSON: ${errorText(err)}`, { cause: err })
      }
      if (text === undefined) throw new TypeError('slot post: the message is not JSON')
      if (text.length > MAX_PANEL_MESSAGE_LENGTH) {
        throw new RangeError(`slot post: message of ${text.length} chars exceeds ${MAX_PANEL_MESSAGE_LENGTH}`)
      }
      if (frame.ended) return
      try {
        frame.port.postMessage(text)
      } catch (err) {
        this.log(frame.pluginId, `slot post to ${frame.id} failed: ${errorText(err)}`)
      }
    }
    const onMessage = (listener: MessageListener): Disposer => {
      if (typeof listener !== 'function') throw new TypeError('slot onMessage needs a function')
      if (frame.ended) return () => {}
      const entry: MessageListener = (m) => listener(m)
      frame.messageListeners.add(entry)
      return () => {
        frame.messageListeners.delete(entry)
      }
    }
    const onClose = (listener: () => void): Disposer => {
      if (typeof listener !== 'function') throw new TypeError('slot onClose needs a function')
      if (frame.ended) {
        // Registered after the end: told at once, so a late listener still cleans up.
        queueMicrotask(() => {
          try {
            listener()
          } catch (err) {
            this.log(frame.pluginId, `a slot onClose listener threw: ${errorText(err)}`)
          }
        })
        return () => {}
      }
      const entry = (): void => listener()
      frame.closeListeners.add(entry)
      return () => {
        frame.closeListeners.delete(entry)
      }
    }
    return Object.freeze({
      id: tag.id,
      type: tag.type,
      host: Object.freeze(structuredClone(tag.host)),
      params: tag.params === undefined ? undefined : structuredClone(tag.params),
      post,
      onMessage,
      onClose
    }) as SlotInstance
  }

  /** A message from the slot's page: a JSON string within the cap, else dropped (logged). */
  private receive(frame: Frame, raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_PANEL_MESSAGE_LENGTH) {
      this.log(frame.pluginId, `dropped a message from slot ${frame.id}: not a JSON string within the size cap`)
      return
    }
    let parsed: JsonValue
    try {
      parsed = JSON.parse(raw) as JsonValue
    } catch {
      this.log(frame.pluginId, `dropped a message from slot ${frame.id}: not JSON`)
      return
    }
    for (const listener of [...frame.messageListeners]) {
      try {
        listener(structuredClone(parsed))
      } catch (err) {
        this.log(frame.pluginId, `a slot onMessage listener threw: ${errorText(err)}`)
      }
    }
  }
}

export interface SlotsApiDeps {
  pluginId: string
  /** The types the manifest's `contributes.slots` declares; `onOpen` accepts only these. */
  types: readonly string[]
  call(method: string, params: unknown): Promise<unknown>
  /** Throws when the plugin is deactivated. */
  alive(): void
  guardAsync<T>(body: () => Promise<T>): Promise<T>
  hub: SlotHub
}

export function createSlotsApi(deps: SlotsApiDeps): PluginContext['slots'] {
  const { pluginId, types, call, guardAsync } = deps
  return Object.freeze({
    onOpen: (type: string, listener: (slot: SlotInstance) => void): Disposer => {
      deps.alive()
      if (typeof type !== 'string' || !types.includes(type)) {
        throw new Error(`slots.onOpen: "${String(type)}" is not declared in plugin.json contributes.slots`)
      }
      if (typeof listener !== 'function') throw new TypeError('slots.onOpen needs a function')
      return deps.hub.onOpen(pluginId, type, listener)
    },
    available: (type: string): Promise<boolean> =>
      guardAsync(async () => {
        if (typeof type !== 'string' || !SLOT_TYPE_PATTERN.test(type)) {
          throw new TypeError(`slots.available: type must match ${SLOT_TYPE_PATTERN.source}`)
        }
        return (await call('slots.available', { pluginId, type })) === true
      })
  })
}
