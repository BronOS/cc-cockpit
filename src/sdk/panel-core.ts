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
//
// Messages on the port are ONE JSON string each, the format of the host side (host/ctx/ui.ts), with
// the same 1 MiB cap. A page may post before its port arrived (it usually does, at load): those
// wait in a bounded queue and go out, in order, once it does.

export const MAX_PANEL_MESSAGE_LENGTH = 1024 * 1024
/** Posts kept while the page has no port yet; more is a page in a loop, not a page loading. */
export const MAX_QUEUED_MESSAGES = 100

export const PORT_MESSAGE = 'cc-plugin.port'
export const THEME_MESSAGE = 'cc-plugin.theme'

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
    componentsCss?: string
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
    this.api = Object.freeze({
      post: (message: JsonValue) => this.post(message),
      onMessage: (listener: (message: JsonValue) => void) => this.onMessage(listener),
      theme: Object.freeze(theme) as PanelApi['theme']
    })
  }

  /** A message from the parent window (the bootstrap checked its source). */
  receive(data: unknown, ports: readonly PortLike[]): void {
    const type = (data as { type?: unknown } | null)?.type
    if (type === PORT_MESSAGE && ports[0]) this.connect(ports[0])
    else if (type === THEME_MESSAGE) {
      this.installBaseStyles((data as { mac?: unknown }).mac === true)
      this.applyTheme((data as { theme?: unknown }).theme)
    }
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
