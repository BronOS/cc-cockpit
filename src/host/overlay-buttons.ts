// The host's registry of `ctx.overlay.buttons(type, provider)` (design-next §3.3): buttons a plugin
// adds to every overlay of a type, whoever opened it (the Editor's "Edit" on a `file`, Gmail's
// "Mark read" on its own `inbox-item`).
//
// Registration is code and stays host-local, so a provider can look at the data and at its
// plugin's state. When a typed overlay opens in this host's window, main asks once
// (`overlay.buttons { key, info }`); every provider for the type is called with the overlay's info,
// each bounded to PROVIDER_TIMEOUT_MS (a slow or throwing one is skipped and logged in its own
// plugin's log, so one broken plugin never holds up the toolbar), and the answer is plain data:
// each button with the id of the plugin whose ctx registered the provider. That id comes from the
// registration, never from what a provider returns. The `run` functions stay here, keyed by
// overlay key, plugin and button id; a click comes back as `overlay.buttonClick { key, pluginId,
// buttonId, info }` and runs the one main named. Main asks again after every click and on the
// opener's setButtons, and each answer replaces the overlay's runs.
//
// `key` is main's per-overlay key for this, not the overlay id (that never leaves main). Main sends
// `overlay.ended { key }` when the overlay goes, and the runs go with it; a plugin's ctx that ends
// (reload, unload, deactivate) takes its providers and runs along (removePlugin).
//
// What a provider is told came from the opener (another plugin, the CLI), so it is untrusted input
// for the provider: each gets its own frozen copy, and the guide asks a provider to check the data
// (a source checks that the id is one of its own, the Editor resolves the path inside the project).
import type { Disposer, JsonValue, OverlayInfo, OverlayTypeButton } from '../sdk/types'
import { errorText } from '../shared/error-text'
import {
  MAX_OVERLAY_BUTTONS,
  isOverlayTypeName,
  parseOverlayButtons,
  type CleanOverlayButton,
  type CleanTypeButton
} from '../shared/overlay-buttons'

/** How long one provider may take to answer (design-next §3.3); a slower one is skipped. */
export const PROVIDER_TIMEOUT_MS = 500
/** Main's key for an overlay: a UUID in practice; capped so a bad one cannot bloat the maps. */
const MAX_KEY_LENGTH = 100
const MAX_TITLE_LENGTH = 200
const MAX_OPENER_LENGTH = 200

type Provider = (o: OverlayInfo) => OverlayTypeButton[] | Promise<OverlayTypeButton[]>
type Run = OverlayTypeButton['run']

interface Registration {
  readonly pluginId: string
  readonly type: string
  readonly provider: Provider
}


/** The overlay as main describes it to the providers, checked. */
function infoOf(value: unknown): OverlayInfo {
  const { type, title, opener } = (value ?? {}) as Record<string, unknown>
  const { name, data } = (type ?? {}) as Record<string, unknown>
  if (!isOverlayTypeName(name)) throw new Error('overlay.buttons: bad type name')
  if (typeof title !== 'string' || title.length > MAX_TITLE_LENGTH) throw new Error('overlay.buttons: bad title')
  if (typeof opener !== 'string' || opener.length > MAX_OPENER_LENGTH) throw new Error('overlay.buttons: bad opener')
  let copy: JsonValue
  try {
    // Plain JSON only (main sends its clean copy; checked again, as everything from the port).
    copy = JSON.parse(JSON.stringify(data ?? null)) as JsonValue
  } catch {
    throw new Error('overlay.buttons: type data is not JSON')
  }
  return { type: { name, data: copy }, title, opener }
}

function keyOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > MAX_KEY_LENGTH) throw new Error(`${what}: bad key`)
  return value
}

/** A deep, frozen copy for one provider or run: one plugin cannot change what the next one sees. */
function frozenInfo(info: OverlayInfo): OverlayInfo {
  const deepFreeze = <T>(v: T): T => {
    if (typeof v === 'object' && v !== null) {
      for (const inner of Object.values(v)) deepFreeze(inner)
      Object.freeze(v)
    }
    return v
  }
  return deepFreeze(structuredClone(info))
}

/** `promise`, or the timeout's rejection after `ms`; the timer never outlives the race. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class OverlayButtonRegistry {
  /** In registration order: a plugin's buttons keep the order of its providers. */
  private registrations: Registration[] = []
  /** Overlay key -> `<pluginId>/<buttonId>` -> its run, as of the latest answer for that overlay. */
  private readonly runs = new Map<string, Map<string, Run>>()
  /**
   * Overlay key -> the token of the list call that may still store its runs. A newer call replaces
   * it, `ended` drops it: an answer that comes back after the overlay ended (or after a newer
   * answer) stores nothing, so no run outlives its overlay.
   */
  private readonly current = new Map<string, object>()

  constructor(
    private readonly log: (pluginId: string, message: string) => void,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS
  ) {}

  /** ctx.overlay.buttons: the caller checked the plugin is alive; the arguments are checked here. */
  register(pluginId: string, type: string, provider: Provider): Disposer {
    if (!isOverlayTypeName(type)) {
      throw new TypeError(
        `overlay.buttons: type ${JSON.stringify(String(type)).slice(0, 60)} must be a lower-case noun of letters, digits and "-" (at most 64)`
      )
    }
    if (typeof provider !== 'function') throw new TypeError('overlay.buttons needs a provider function')
    // Its own object: the same function registered twice is two registrations, each with its disposer.
    const entry: Registration = { pluginId, type, provider }
    this.registrations.push(entry)
    return () => {
      this.registrations = this.registrations.filter((r) => r !== entry)
    }
  }

  /** The plugin's ctx ended: its providers and the runs of its buttons go. */
  removePlugin(pluginId: string): void {
    this.registrations = this.registrations.filter((r) => r.pluginId !== pluginId)
    const prefix = `${pluginId}/`
    for (const runs of this.runs.values()) for (const id of [...runs.keys()]) if (id.startsWith(prefix)) runs.delete(id)
  }

  /**
   * main's `overlay.buttons { key, info }`: every provider for the type, at once, each bounded. The
   * buttons are grouped per plugin in registration order, at most MAX_OVERLAY_BUTTONS per plugin
   * (the opener's cap), a later duplicate id of the same plugin dropped; a provider whose answer is
   * not a valid list (or has a button without a `run`) is skipped whole, logged in its plugin's log.
   */
  async list(params: unknown): Promise<CleanTypeButton[]> {
    const { key: rawKey, info: rawInfo } = (params ?? {}) as Record<string, unknown>
    const key = keyOf(rawKey, 'overlay.buttons')
    const info = infoOf(rawInfo)
    const token = {}
    this.current.set(key, token)
    const asked = this.registrations.filter((r) => r.type === info.type.name)
    const answers = await Promise.all(asked.map((r) => this.ask(r, info)))
    const buttons: CleanTypeButton[] = []
    const runs = new Map<string, Run>()
    const perPlugin = new Map<string, number>()
    answers.forEach((answer, i) => {
      const reg = asked[i]!
      // A ctx that ended while its provider was answering: nobody would hear the click.
      if (!answer || !this.registrations.includes(reg)) return
      for (const { button, run } of answer) {
        const id = `${reg.pluginId}/${button.id}`
        if (runs.has(id)) {
          this.log(reg.pluginId, `overlay.buttons(${info.type.name}): button id "${button.id}" is used twice; the later one is dropped`)
          continue
        }
        const count = perPlugin.get(reg.pluginId) ?? 0
        if (count >= MAX_OVERLAY_BUTTONS) {
          this.log(reg.pluginId, `overlay.buttons(${info.type.name}): more than ${MAX_OVERLAY_BUTTONS} buttons; "${button.id}" is dropped`)
          continue
        }
        perPlugin.set(reg.pluginId, count + 1)
        runs.set(id, run)
        buttons.push({ ...button, pluginId: reg.pluginId })
      }
    })
    if (this.current.get(key) === token) {
      this.current.delete(key)
      this.runs.set(key, runs)
    }
    return buttons
  }

  /**
   * main's `overlay.buttonClick { key, pluginId, buttonId, info }`: run that button with the
   * overlay's info. `{ close: true }` when its run asked for it, else null. A run that throws is
   * logged in its plugin's log and the error goes back to main (the button is idle again there).
   */
  async click(params: unknown): Promise<{ close: true } | null> {
    const { key: rawKey, pluginId, buttonId, info: rawInfo } = (params ?? {}) as Record<string, unknown>
    const key = keyOf(rawKey, 'overlay.buttonClick')
    if (typeof pluginId !== 'string' || typeof buttonId !== 'string') throw new Error('overlay.buttonClick: bad button')
    const info = infoOf(rawInfo)
    const run = this.runs.get(key)?.get(`${pluginId}/${buttonId}`)
    if (!run) throw new Error(`overlay.buttonClick: ${pluginId} has no button "${buttonId}" on that overlay now`)
    let result: unknown
    try {
      // Through a resolved promise: a run that throws synchronously lands in the same catch.
      result = await Promise.resolve().then(() => run(frozenInfo(info)))
    } catch (err) {
      this.log(pluginId, `overlay button "${buttonId}" failed: ${errorText(err)}`)
      throw err
    }
    const close = typeof result === 'object' && result !== null && (result as { close?: unknown }).close === true
    return close ? { close: true } : null
  }

  /** main's `overlay.ended { key }`: the overlay went; its runs go (and a list still running stores none). */
  ended(params: unknown): void {
    const key = (params as { key?: unknown } | null)?.key
    if (typeof key !== 'string') return
    this.runs.delete(key)
    this.current.delete(key)
  }

  /** One provider's answer, checked: undefined when it threw, timed out or answered junk (logged). */
  private async ask(reg: Registration, info: OverlayInfo): Promise<{ button: CleanOverlayButton; run: Run }[] | undefined> {
    const what = `overlay.buttons(${reg.type})`
    let raw: unknown
    try {
      raw = await within(
        Promise.resolve().then(() => reg.provider(frozenInfo(info))),
        this.timeoutMs,
        what
      )
    } catch (err) {
      this.log(reg.pluginId, `${what}: the provider is skipped: ${errorText(err)}`)
      return undefined
    }
    try {
      const clean = parseOverlayButtons(raw, what)
      const list = raw as Record<string, unknown>[]
      return clean.map((button, i) => {
        const run = list[i]!.run
        if (typeof run !== 'function') throw new TypeError(`${what}: button "${button.id}" has no run function`)
        return { button, run: run as Run }
      })
    } catch (err) {
      this.log(reg.pluginId, `${what}: the provider's answer is skipped: ${errorText(err)}`)
      return undefined
    }
  }
}
