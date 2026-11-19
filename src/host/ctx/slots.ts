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
import type { Disposer, JsonValue, PluginContext, SlotInstance, ViewAccess } from '../../sdk/types'
import { errorText } from '../../shared/error-text'
import { MAX_SLOT_PARAMS_BYTES, SLOT_FRAME_ID_PATTERN, SLOT_TYPE_PATTERN, type SlotHost } from '../../shared/slots'
import { viewIdOf, type ViewId } from '../../shared/views'
import { PortLine } from './port-line'
import { DESKTOP_VIEW, type PanelPort } from './ui'
import { HostViews, tagAccess } from './views'


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
  /**
   * The remote view whose frame this is (design-web.md §5.3); absent: the desktop window's. One
   * frame id can be open in several views at once, each its own instance with its own port.
   */
  view?: ViewId
  /** Who is behind that view, from main's tag (views.ts tagAccess; main always writes it). */
  access: ViewAccess
}

/** The frames map's key: one frame id per view (absent view: the desktop window's). */
function frameKey(pluginId: string, id: string, view: ViewId | undefined): string {
  return view === undefined ? `${pluginId}/${id}` : `${pluginId}/${id}\n${view}`
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
    // A view main did not mint is refused, never read as the desktop's frame (it would close it).
    const view = viewIdOf(tag.view)
    if (tag.view !== undefined && view === undefined) return undefined
    // A malformed role refuses the frame, never reads as the owner.
    const access = tagAccess(tag.access, view)
    if (access === null) return undefined
    return {
      pluginId,
      id,
      type,
      host,
      ...(params !== undefined ? { params: params as JsonValue } : {}),
      ...(view !== undefined ? { view } : {}),
      access
    }
  } catch {
    // Not one of main's port messages.
  }
  return undefined
}

/** One open frame of this host: the provider plugin's side. */
interface Frame {
  readonly pluginId: string
  readonly id: string
  readonly line: PortLine
}

/** The open slot frames and `onOpen` listeners of every plugin of one host. */
export class SlotHub {
  /** `<pluginId>/<type>` -> listeners. */
  private readonly openers = new Map<string, Set<(slot: SlotInstance) => void>>()
  /** frameKey(pluginId, frameId, view) -> frame. */
  private readonly frames = new Map<string, Frame>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    /** ctx.views: every open frame is one line of its view (views.ts). */
    private readonly views: HostViews = new HostViews(log)
  ) {}

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
   * plugin runs here and declares the type. A frame with the same id IN THE SAME VIEW is closed
   * first (main does that too, a reconnect of one id); the same frame in another view is another
   * instance and stays. `onPortClose` is how the adapter reports the page's end going away; it
   * ends only this frame, never a newer one with the same id.
   */
  open(tag: SlotOpenTag, port: PanelPort): void {
    const key = frameKey(tag.pluginId, tag.id, tag.view)
    const old = this.frames.get(key)
    if (old) old.line.end()
    const release = this.views.add(tag.pluginId, tag.view ?? DESKTOP_VIEW, tag.access)
    const line = new PortLine(
      port,
      tag.view,
      { kind: 'slot', who: `slot ${tag.id}`, postTo: ` to ${tag.id}` },
      (message) => this.log(tag.pluginId, message),
      () => {
        if (this.frames.get(key) === frame) this.frames.delete(key)
        release()
      }
    )
    const frame: Frame = { pluginId: tag.pluginId, id: tag.id, line }
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

  /**
   * main's `slot.close { pluginId, id, view? }`, or the page's port closing (`port`: only that
   * frame's own). Only the frame of that id in `view` (absent: the desktop window's).
   */
  close(pluginId: string, id: string, view?: ViewId, port?: PanelPort): void {
    const frame = this.frames.get(frameKey(pluginId, id, view))
    if (frame && (port === undefined || frame.line.port === port)) frame.line.end()
  }

  /** The plugin is gone: its frames end (onClose runs) and its listeners drop. */
  removePlugin(pluginId: string): void {
    for (const frame of [...this.frames.values()]) if (frame.pluginId === pluginId) frame.line.end()
    const prefix = `${pluginId}/`
    for (const key of [...this.openers.keys()]) if (key.startsWith(prefix)) this.openers.delete(key)
  }

  /** How many frames of the plugin are open (tests). */
  openCount(pluginId: string): number {
    let n = 0
    for (const f of this.frames.values()) if (f.pluginId === pluginId) n++
    return n
  }

  private instanceOf(frame: Frame, tag: SlotOpenTag): SlotInstance {
    return Object.freeze({
      id: tag.id,
      type: tag.type,
      host: Object.freeze(structuredClone(tag.host)),
      params: tag.params === undefined ? undefined : structuredClone(tag.params),
      access: tag.access,
      post: frame.line.post,
      onMessage: frame.line.onMessage,
      onClose: frame.line.onClose
    }) as SlotInstance
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
