// The panel SDK's logic (design §5 › Panel side: `post`, `onMessage`, `theme`), DOM-free so unit
// tests run it in plain Node with fakes. src/sdk/panel.ts wires it to the page's window and is
// what plugins load, as `<script src="/__sdk/panel.js">` (served inside every plugin's origin).
//
// What reaches a panel page, all from its parent (the shell renderer), checked by the bootstrap to
// come from `window.parent`:
//   { type: 'cc-plugin.port' } + a MessagePort   the line to the plugin's host (or, for an html
//                                                 overlay, to the overlay itself); a later one
//                                                 replaces the earlier one
//   { type: 'cc-plugin.theme', theme: { kind, vars }, mac }   the app's theme, again on every change;
//                                                 `mac` is the shell's platform (no scrollbar rule there)
//   { type: 'cc-plugin.slot', slot: { type } }     the page is a slot frame of that type (sent once, with
//                                                 the port); from then on `ccPanel.slot` exists
// and the other way, to the parent only:
//   { type: 'cc-plugin.slot-height', height }      `ccPanel.slot.setHeight(px)`: the shell sizes the frame
//   { type: 'cc-plugin.slot-width', width }        `ccPanel.slot.setWidth(px)`: the top bar's frame takes
//                                                 that width (other positions ignore it)
//   { type: 'cc-plugin.ready' }                    `ccPanel.ready()`: an html overlay's page has drawn, its
//                                                 loader goes (spec `ready: 'manual'`); ignored elsewhere
//
// Messages on the port are ONE JSON string each, the format of the host side (host/ctx/ui.ts), with
// the same 1 MiB cap. A page may post before its port arrived (it usually does, at load): those
// wait in a bounded queue and go out, in order, once it does.

export const MAX_PANEL_MESSAGE_LENGTH = 1024 * 1024
/** Posts kept while the page has no port yet; more is a page in a loop, not a page loading. */
export const MAX_QUEUED_MESSAGES = 100

export const PORT_MESSAGE = 'cc-plugin.port'
export const THEME_MESSAGE = 'cc-plugin.theme'
export const SLOT_MESSAGE = 'cc-plugin.slot'
export const SLOT_HEIGHT_MESSAGE = 'cc-plugin.slot-height'
export const SLOT_WIDTH_MESSAGE = 'cc-plugin.slot-width'
export const READY_MESSAGE = 'cc-plugin.ready'

// A copy of the bounds in src/shared/slots.ts, on purpose (see errorText below): the shell and
// main clamp to the provider's min/max again, this only keeps a page's number sane.
const SLOT_HEIGHT_MIN = 24
const SLOT_HEIGHT_MAX = 600
const SLOT_WIDTH_MIN = 0
const SLOT_WIDTH_MAX = 4096
const SLOT_TYPE = /^[a-z][a-z0-9-]{0,63}$/

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The page's end of its channel: a MessagePort in the browser, a fake in tests. */
export interface PortLike {
  postMessage(message: string): void
  onmessage: ((event: { data: unknown }) => void) | null
  close(): void
}

export interface PanelTheme {
  kind: 'light' | 'dark'
  vars: Record<string, string>
}

/** Where the theme goes: the page's `:root` style in the browser. */
export interface ThemeRoot {
  setProperty(name: string, value: string): void
  removeProperty(name: string): unknown
  colorScheme: string
}

/**
 * Where the SDK's stylesheets go: in the browser, each `install` is a constructable sheet adopted
 * after the SDK's earlier ones and before the page's own (`sdkSheetsFirst`), so the order is the
 * components, then the scrollbars, then whatever the page adopts.
 */
export interface BaseStyles {
  install(css: string): void
}

/**
 * The document's adopted sheets with the SDK's in front, in the order they were installed. A sheet
 * the page adopted itself keeps its place after them (and is not duplicated when the page had put
 * an SDK sheet in its own list). Generic so tests run it without a CSSOM.
 */
export function sdkSheetsFirst<T>(sdk: readonly T[], current: readonly T[]): T[] {
  return [...sdk, ...current.filter((sheet) => !sdk.includes(sheet))]
}

/**
 * Thin themed scrollbars for every plugin page, at zero specificity (`:where`) so the plugin's own
 * CSS wins. The same rule, for the shell, is in src/renderer/styles.css. `scrollbar-color` inherits,
 * `scrollbar-width` does not, hence the `*`. Not installed on macOS (the theme message's `mac`): its
 * overlay scrollbars already look right, and these properties turn them into always-visible classic bars.
 */
export const BASE_SCROLLBAR_CSS =
  ':where(:root) { scrollbar-color: color-mix(in srgb, var(--cc-fg, #888) 22%, transparent) transparent; }\n' +
  ':where(*) { scrollbar-width: thin; }\n' +
  ':where(*:hover) { scrollbar-color: color-mix(in srgb, var(--cc-fg, #888) 38%, transparent) transparent; }'

/** `ccPanel.slot`: present when the page is shown as a slot (design-next §2). */
export interface SlotPageApi {
  readonly type: string
  /**
   * Ask the shell for a frame height in px: rounded and kept within 24 to 600 here, then within the
   * slot's `[minHeight, placement height]` by the shell. The default is the placement's height.
   */
  setHeight(px: number): void
  /**
   * Ask the shell for a frame width in px: rounded and kept within 0 to 4096 here. Only a frame in
   * the app's top bar takes it, capped so part of the bar is always left to drag the window (macOS);
   * the other positions ignore it. A top-bar page that never asks takes the most the bar allows,
   * so report the width of what it draws (0 for nothing), e.g. from a ResizeObserver.
   */
  setWidth(px: number): void
}

export interface PanelApi {
  /** Send to the plugin (JSON, at most 1 MiB as text). Queued until the page is connected. */
  post(message: JsonValue): void
  /** Hear what the plugin posts; returns the unsubscribe. */
  onMessage(listener: (message: JsonValue) => void): () => void
  readonly theme: {
    /** The app's current theme (`vars` are the CSS variables already set on `:root`). */
    readonly current: PanelTheme | undefined
    onChange(listener: (theme: PanelTheme) => void): () => void
  }
  /** Set (a frozen object) once the shell says the page is a slot; undefined for a panel or an overlay. */
  readonly slot: SlotPageApi | undefined
  /**
   * An html overlay's page has drawn what it shows: the app's loader over it goes. Needed only for
   * an overlay opened with `ready: 'manual'` (the default loader goes at load); harmless elsewhere.
   */
  ready(): void
}

const VAR_NAME = /^--[A-Za-z][A-Za-z0-9_-]*$/

// A copy of src/shared/error-text.ts, on purpose: this file is bundled into out/sdk/panel.js, a
// classic script. A module that main imports as well would land in a shared chunk that panel.js
// loads with `require`, which throws in a page (see the build notes in electron.vite.config.ts).
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Only plausible theme data: names of CSS variables, short string values (the shell validated them). */
function cleanTheme(raw: unknown): PanelTheme | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { kind, vars } = raw as { kind?: unknown; vars?: unknown }
  if ((kind !== 'light' && kind !== 'dark') || typeof vars !== 'object' || vars === null) return undefined
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(vars).slice(0, 200)) {
    if (VAR_NAME.test(name) && typeof value === 'string' && value.length <= 100) out[name] = value
  }
  return { kind, vars: out }
}

export class PanelClient {
  private port: PortLike | undefined
  private queue: string[] = []
  private readonly listeners = new Set<(message: JsonValue) => void>()
  private readonly themeListeners = new Set<(theme: PanelTheme) => void>()
  private theme: PanelTheme | undefined
  private applied: string[] = []
  private baseStyled = false
  private slotType: string | undefined
  private slotApi: SlotPageApi | undefined
  readonly api: PanelApi

  /**
   * `componentsCss` is the app's component stylesheet (src/sdk/components.css), installed at once:
   * unlike the scrollbars it does not wait for the theme message (it is on macOS too, and a page
   * should not draw its first frame with bare controls). Its colours are theme variables, which
   * resolve when the theme lands on `:root`.
   */
  constructor(
    private readonly root: ThemeRoot,
    private readonly warn: (message: string) => void = () => {},
    private readonly styles?: BaseStyles,
    componentsCss?: string,
    /** Where a slot page's size requests and `ready()` go: the parent window (the shell), in the browser. */
    private readonly toParent?: (message: { type: string; height?: number; width?: number }) => void
  ) {
    const theme = {
      onChange: (listener: (theme: PanelTheme) => void): (() => void) => {
        if (typeof listener !== 'function') throw new TypeError('theme.onChange needs a function')
        this.themeListeners.add(listener)
        return () => {
          this.themeListeners.delete(listener)
        }
      }
    }
    // A getter (a copy each read): the page sees the latest theme and cannot change the SDK's.
    Object.defineProperty(theme, 'current', {
      enumerable: true,
      get: (): PanelTheme | undefined => this.theme && { kind: this.theme.kind, vars: { ...this.theme.vars } }
    })
    if (styles && componentsCss) {
      try {
        styles.install(componentsCss)
      } catch (err) {
        this.warn(`could not install the component styles: ${errorText(err)}`)
      }
    }
    const api = {
      post: (message: JsonValue) => this.post(message),
      onMessage: (listener: (message: JsonValue) => void) => this.onMessage(listener),
      theme: Object.freeze(theme) as PanelApi['theme'],
      ready: (): void => this.toParent?.({ type: READY_MESSAGE })
    }
    // A getter: the page learns it is a slot after load, and `slot` must then appear on the same object.
    Object.defineProperty(api, 'slot', { enumerable: true, get: (): SlotPageApi | undefined => this.slotApi })
    this.api = Object.freeze(api) as PanelApi
  }

  /** A message from the parent window (the bootstrap checked its source). */
  receive(data: unknown, ports: readonly PortLike[]): void {
    const type = (data as { type?: unknown } | null)?.type
    if (type === PORT_MESSAGE && ports[0]) this.connect(ports[0])
    else if (type === SLOT_MESSAGE) this.becomeSlot((data as { slot?: { type?: unknown } }).slot?.type)
    else if (type === THEME_MESSAGE) {
      this.installBaseStyles((data as { mac?: unknown }).mac === true)
      this.applyTheme((data as { theme?: unknown }).theme)
    }
  }

  /** The shell says this page is a slot frame; the first message wins (the type of a frame does not change). */
  private becomeSlot(type: unknown): void {
    if (this.slotType !== undefined || typeof type !== 'string' || !SLOT_TYPE.test(type)) return
    this.slotType = type
    this.slotApi = Object.freeze({
      type,
      setHeight: (px: number): void => {
        if (typeof px !== 'number' || !Number.isFinite(px)) throw new TypeError('slot.setHeight needs a finite number of px')
        const height = Math.min(SLOT_HEIGHT_MAX, Math.max(SLOT_HEIGHT_MIN, Math.round(px)))
        this.toParent?.({ type: SLOT_HEIGHT_MESSAGE, height })
      },
      // Sent from any slot position: the page cannot know where it is drawn (a type may be placed
      // in a column and in the bar), and the shell is the one that knows to ignore it.
      setWidth: (px: number): void => {
        if (typeof px !== 'number' || !Number.isFinite(px)) throw new TypeError('slot.setWidth needs a finite number of px')
        const width = Math.min(SLOT_WIDTH_MAX, Math.max(SLOT_WIDTH_MIN, Math.round(px)))
        this.toParent?.({ type: SLOT_WIDTH_MESSAGE, width })
      }
    })
  }

  private connect(port: PortLike): void {
    if (this.port) {
      this.port.onmessage = null
      try {
        this.port.close()
      } catch {
        // Already closed.
      }
    }
    this.port = port
    // Assigning onmessage also starts the port (a MessagePort queues until then).
    port.onmessage = (event) => this.deliver(event.data)
    for (const text of this.queue.splice(0)) port.postMessage(text)
  }

  private post(message: JsonValue): void {
    let text: string | undefined
    try {
      text = JSON.stringify(message)
    } catch (err) {
      throw new TypeError(`post: the message is not JSON: ${errorText(err)}`, { cause: err })
    }
    if (text === undefined) throw new TypeError('post: the message is not JSON')
    if (text.length > MAX_PANEL_MESSAGE_LENGTH) {
      throw new RangeError(`post: message of ${text.length} chars exceeds ${MAX_PANEL_MESSAGE_LENGTH}`)
    }
    if (this.port) {
      this.port.postMessage(text)
      return
    }
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      this.warn(`post: not connected and ${MAX_QUEUED_MESSAGES} messages are waiting; this one is dropped`)
      return
    }
    this.queue.push(text)
  }

  private onMessage(listener: (message: JsonValue) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('onMessage needs a function')
    // Wrapped, so the same function added twice is two listeners and each unsubscribe removes one.
    const entry = (m: JsonValue): void => listener(m)
    this.listeners.add(entry)
    return () => {
      this.listeners.delete(entry)
    }
  }

  /** What arrived on the port: one JSON string within the cap, else dropped. */
  private deliver(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > MAX_PANEL_MESSAGE_LENGTH) {
      this.warn('dropped a message that is not a JSON string within the size cap')
      return
    }
    let parsed: JsonValue
    try {
      parsed = JSON.parse(raw) as JsonValue
    } catch {
      this.warn('dropped a message that is not JSON')
      return
    }
    for (const listener of [...this.listeners]) {
      try {
        // Each listener its own copy: one cannot change what the next one sees.
        listener(structuredClone(parsed))
      } catch (err) {
        this.warn(`an onMessage listener threw: ${errorText(err)}`)
      }
    }
  }

  private installBaseStyles(mac: boolean): void {
    if (this.baseStyled || mac || !this.styles) return
    this.baseStyled = true
    try {
      this.styles.install(BASE_SCROLLBAR_CSS)
    } catch (err) {
      this.warn(`could not install the base styles: ${errorText(err)}`)
    }
  }

  private applyTheme(raw: unknown): void {
    const theme = cleanTheme(raw)
    if (!theme) return
    for (const name of this.applied) if (!(name in theme.vars)) this.root.removeProperty(name)
    for (const [name, value] of Object.entries(theme.vars)) this.root.setProperty(name, value)
    this.applied = Object.keys(theme.vars)
    this.root.colorScheme = theme.kind
    this.theme = theme
    for (const listener of [...this.themeListeners]) {
      try {
        listener({ kind: theme.kind, vars: { ...theme.vars } })
      } catch (err) {
        this.warn(`a theme.onChange listener threw: ${errorText(err)}`)
      }
    }
  }
}
