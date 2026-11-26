// The panel SDK's logic (design §5 › Panel side: `post`, `onMessage`, `theme`), DOM-free so unit
// tests run it in plain Node with fakes. src/sdk/panel.ts wires it to the page's window and is
// what plugins load, as `<script src="../__sdk/panel.js">` (served at every plugin's root, a URL relative
// to the page).
//
// What reaches a panel page, all from its parent (the shell renderer), checked by the bootstrap to
// come from `window.parent`:
//   { type: 'cc-plugin.port', remote, access? } + a MessagePort   the line to the plugin's host (or,
//                                                 for an html overlay, to the overlay itself); a later
//                                                 one replaces the earlier one. `remote`: the shell that
//                                                 mounts the page is the web shell (a web access
//                                                 browser view), read as `ccPanel.view.remote`.
//                                                 `access`: who is behind that shell (`read` | `write`
//                                                 for a guest; absent: the owner), read as
//                                                 `ccPanel.view.access`. Both are UI hints only: the
//                                                 plugin's host learns the access from main's tag.
//   { type: 'cc-plugin.theme', theme: { kind, vars }, mac }   the app's theme, again on every change;
//                                                 `mac` is the shell's platform (there the scrollbar
//                                                 rule is on only while the page measures classic bars,
//                                                 scroll-edges-core.ts)
//   { type: 'cc-plugin.slot', slot: { type } }     the page is a slot frame of that type (sent once, with
//                                                 the port); from then on `ccPanel.slot` exists
//   { type: 'cc-plugin.overlay', overlay: { notes, ask, discuss } }   the page is a perView overlay copy
//                                                 (sent before every port): from then on `ccPanel.overlay`,
//                                                 and `ccPanel.notes` / `ccPanel.ask` when on, exist, and `$cc`
//                                                 envelopes on the port are the app's (panel-overlay.ts)
//   { type: 'cc-plugin.tab', tab: { type }, keys? } the page is a page tab of that type (sent before every
//                                                 port); from then on `ccPanel.tab` exists. A page tab's
//                                                 frame is never reloaded to reconnect: a later port
//                                                 (host restart, web reconnect) fires `onConnect`.
//                                                 `keys` (web shell only, sent again when the app's key
//                                                 table changes): the app's chords, which the page
//                                                 forwards instead of handling (design-editor.md §1
//                                                 "Keyboard"; on the desktop main takes them first)
// and the other way, to the parent only:
//   { type: 'cc-plugin.slot-height', height }      `ccPanel.slot.setHeight(px)`: the shell sizes the frame
//   { type: 'cc-plugin.slot-width', width }        `ccPanel.slot.setWidth(px)`: the top bar's frame takes
//                                                 that width (other positions ignore it)
//   { type: 'cc-plugin.ready' }                    `ccPanel.ready()`: an html overlay's page has drawn, its
//                                                 loader goes (spec `ready: 'manual'`); ignored elsewhere.
//                                                 `early: true` when the page had no port yet (it drew
//                                                 before its frame's `load`): the shell cannot tell which
//                                                 load of the frame that was (a page that reloads itself
//                                                 keeps its window), so the SDK says it again, unmarked,
//                                                 once the port came, and that one names the load
//   { type: 'cc-plugin.tab-dirty', dirty }         `ccPanel.tab.setDirty(bool)`: the page tab holds unsaved
//                                                 changes in this view, or not (sent on a change only)
//   { type: 'cc-plugin.tab-key', chord, code }     an app chord typed in a page tab (one of `keys`): the
//                                                 page did not handle it, the shell runs its command
//                                                 (`code`: the key's physical code, held after a pane chord)
//   { type: 'cc-plugin.tab-discuss' }              `ccPanel.tab.discuss()`: Ask Claude from this page tab;
//                                                 the shell draws its question box (design-editor.md §4)
//   { type: 'cc-plugin.upload', folder, files, folders }   `ccPanel.upload.pick` / `files` (design-upload.md
//                                                 §5.2): `files` the chosen or dropped `File`s, `folders` the
//                                                 names of dropped folders (skipped: no folder uploads).
//                                                 The shell takes it only from a panel frame in a zone
//                                                 (renderer/web/upload-request.ts) and names that panel in
//                                                 `uploads.begin`; main checks the folder and every name
//
// Messages on the port are ONE JSON string each, the format of the host side (host/ctx/ui.ts), with
// the same 1 MiB cap. A page may post before its port arrived (it usually does, at load): those
// wait in a bounded queue and go out, in order, once it does. A top-level `$cc` key is the app's
// (shared/overlay-envelope.ts): `post` refuses one, and on an overlay copy's port it is the app's
// answer or push, never handed to `onMessage`.

import { BASE_SCROLLBAR_CSS, SCROLL_EDGES_CSS } from './scroll-edges-core'
import { hasEnvelopeKey, isEnvelope, OVERLAY_INTRO_MESSAGE } from '../shared/overlay-envelope'
import { OverlayCopyClient, type PanelAskApi, type PanelNotesApi, type PanelOverlayApi } from './panel-overlay'

export type { AskEventType, PanelAskApi, PanelNotesApi, PanelOverlayApi } from './panel-overlay'

export const MAX_PANEL_MESSAGE_LENGTH = 1024 * 1024
/** Posts kept while the page has no port yet; more is a page in a loop, not a page loading. */
export const MAX_QUEUED_MESSAGES = 100

export const PORT_MESSAGE = 'cc-plugin.port'
export const THEME_MESSAGE = 'cc-plugin.theme'
export const SLOT_MESSAGE = 'cc-plugin.slot'
export const TAB_MESSAGE = 'cc-plugin.tab'
export const SLOT_HEIGHT_MESSAGE = 'cc-plugin.slot-height'
export const SLOT_WIDTH_MESSAGE = 'cc-plugin.slot-width'
export const READY_MESSAGE = 'cc-plugin.ready'
export const TAB_DIRTY_MESSAGE = 'cc-plugin.tab-dirty'
export const TAB_KEY_MESSAGE = 'cc-plugin.tab-key'
/** The web shell lists the app's chords to a panel or slot frame (a page tab gets them with its intro). */
export const KEYS_MESSAGE = 'cc-plugin.keys'
export const TAB_DISCUSS_MESSAGE = 'cc-plugin.tab-discuss'
/** `ccPanel.upload.pick` / `files`: the files for core's upload flow (design-upload.md §5.2). */
export const UPLOAD_MESSAGE = 'cc-plugin.upload'
/** A `folder` longer than this is no project path (main checks the real one); refused at the call. */
export const MAX_UPLOAD_FOLDER_LENGTH = 4096
/**
 * A page tab's window got the focus (design-split-pages.md §4): a hint for the shell to read which
 * frame holds the keyboard, since a move from frame to frame fires no event in the shell. The shell
 * never trusts it for what it says; it only looks.
 */
export const TAB_FOCUS_MESSAGE = 'cc-plugin.tab-focus'
/** At most this many chords in a `cc-plugin.tab` `keys` list, each at most this long (a sane bound on shell data). */
const MAX_FORWARDED_KEYS = 500
const MAX_CHORD_LENGTH = 64

// A copy of the bounds in src/shared/slots.ts, on purpose (see errorText below): the shell and
// main clamp to the provider's min/max again, this only keeps a page's number sane.
const SLOT_HEIGHT_MIN = 24
const SLOT_HEIGHT_MAX = 600
const SLOT_WIDTH_MIN = 0
const SLOT_WIDTH_MAX = 4096
// A slot type and a page-tab type share one pattern (shared/slots.ts, shared/page-tabs.ts).
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
 * components, then the scroll edges, then the scrollbars, then whatever the page adopts.
 */
export interface BaseStyles {
  install(css: string): void
  /** Turns an installed sheet off or on again, keeping its place (the bars on macOS). */
  enable?(css: string, on: boolean): void
}

/**
 * Says whether the page's bars are classic: `onChange` at once and on every change (watchClassicBars
 * in scroll-edges.ts, in the browser).
 */
export type ClassicBarsWatch = (onChange: (classic: boolean) => void) => void

/**
 * The document's adopted sheets with the SDK's in front, in the order they were installed. A sheet
 * the page adopted itself keeps its place after them (and is not duplicated when the page had put
 * an SDK sheet in its own list). Generic so tests run it without a CSSOM.
 */
export function sdkSheetsFirst<T>(sdk: readonly T[], current: readonly T[]): T[] {
  return [...sdk, ...current.filter((sheet) => !sdk.includes(sheet))]
}

// The scrollbar and edge-fade sheets (edges-only scrolling) live in scroll-edges-core.ts, shared
// with the shell; the page script that marks scroll containers for them is scroll-edges.ts.
export { BASE_SCROLLBAR_CSS, SCROLL_EDGES_CSS }

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

/**
 * `ccPanel.tab`: present when the page is drawn as a page tab (design-editor.md §1, the manifest's
 * `contributes.tabs`). Its frame outlives a plugin host restart and a web reconnect: the shell hands
 * it a new connection instead of loading it again (`ccPanel.onConnect`), and the page re-sends what
 * it holds.
 */
export interface TabPageApi {
  readonly type: string
  /**
   * Say whether the page holds unsaved changes in this view (design-editor.md §1 "Dirty and close").
   * Main keeps it per view: the tab shows the dirty dot while any view says so, and closing it, its
   * window or the app asks the person first. Only a report: the page cannot stop or delay a close.
   * Sent on a change only; the shell keeps it across reconnects.
   */
  setDirty(dirty: boolean): void
  /**
   * Ask Claude from this tab (design-editor.md §4; the editor's Ctrl+L or its context menu): the app
   * draws its question box over the tab, then asks the plugin's `onDiscuss` (in the host) for the
   * context of this view and sends it with the person's question to the Claude tab they pick. Shown
   * only while this tab is the one on screen and its page has the keyboard.
   */
  discuss(): void
}

/**
 * `ccPanel.view`: where the page is drawn. A UI hint only (hide what cannot work there): main refuses
 * a desktop-only call from a browser view whatever the page shows, so no check may rest on it.
 */
export interface PanelViewApi {
  /**
   * The page is drawn in a web access browser view, not the desktop window. Said by the shell that
   * mounts the page, with its port: false until the page is connected (before the host's first
   * message can arrive), and always false on the desktop.
   */
  readonly remote: boolean
  /**
   * Who is behind this view (design-guests §6): `owner`, or a guest the owner invited, `read` or `write`.
   * Said by the shell with the port (`owner` until then and on the desktop). A UI hint only, to hide what
   * the viewer may not use: the plugin's host gets the access from main (`from.access`) and must check it
   * there; a page can claim anything.
   */
  readonly access: 'owner' | 'read' | 'write'
}

/**
 * `ccPanel.upload` (design-upload.md §5.2): hand files from the person's device to core's upload flow,
 * which asks main and shows the clash dialog, the progress and the result. Present only in the web shell
 * for a view that is not a read guest's (a UI hint, as `view`: main refuses by the view it bound); read
 * it at use time, as it appears with the page's connection. Only a panel page's request is taken (the
 * shell ignores an overlay's, a slot's and a page tab's). Both return nothing: core shows the outcome.
 */
export interface PanelUploadApi {
  /**
   * Open the device's file chooser (several files) and upload what the person picks into `folder`
   * (project-relative, `''` the project folder). Call it inside a click or key handler: a browser
   * opens a chooser only on a person's gesture.
   */
  pick(options: { folder: string }): void
  /**
   * Upload `source` into `folder`: a drop's `DataTransfer`, read inside the `drop` handler (after the
   * event its items are gone, and only then can a dropped folder be told from a file: folders are
   * skipped and named by core), or a `FileList` / `File[]`.
   */
  files(source: UploadFilesSource, options: { folder: string }): void
}

/** The fields of a DataTransferItem the SDK reads (a fake in tests). */
export interface UploadItemLike {
  readonly kind: string
  getAsFile(): unknown
  webkitGetAsEntry?: () => { readonly isDirectory?: boolean; readonly name?: string } | null
}

/** A drop's `DataTransfer` as the SDK reads it: its items (the file list alone cannot tell a folder). */
export interface UploadTransferLike {
  readonly items: ArrayLike<UploadItemLike>
  /** A real one has its file list too; never read (see splitTransfer). */
  readonly files?: ArrayLike<unknown>
}

/** What `ccPanel.upload.files` takes: a drop's `DataTransfer`, a `FileList` or an array of `File`s. */
export type UploadFilesSource = UploadTransferLike | ArrayLike<unknown>

/**
 * The page's file chooser, from panel.ts: makes a hidden `<input type=file multiple>`, clicks it at once
 * (inside the caller's gesture) and calls `onFiles` with what the person chose (not on a cancel).
 */
export type UploadChooser = (onFiles: (files: unknown[]) => void) => void

/** Whether a drag carries files from the device (`dataTransfer.types` holds `Files`). */
export function isFilesDrag(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
  return false
}

/**
 * Whether the SDK's window-level cancel applies to a drag: a `Files` drag no handler took, whose target
 * is not an element that takes a drop by the browser's own default action (a file input, a text field,
 * a contenteditable: none of them cancels `dragover`, and `dropEffect = 'none'` would kill their drop).
 */
export function cancelsFilesDrag(
  event: { defaultPrevented: boolean; target: unknown; dataTransfer?: { types?: ArrayLike<string> } | null }
): boolean {
  if (event.defaultPrevented || !isFilesDrag(event.dataTransfer?.types)) return false
  const closest = (event.target as { closest?: (selector: string) => unknown } | null)?.closest
  if (typeof closest !== 'function') return true
  return !closest.call(event.target, 'input, textarea, [contenteditable]:not([contenteditable="false"])')
}

// A DataTransfer by its shape, not `instanceof` (unit tests run without a DOM): it has `items`, a
// FileList and an array do not.
const isTransfer = (source: unknown): source is UploadTransferLike =>
  typeof source === 'object' && source !== null && typeof (source as { items?: unknown }).items === 'object' && (source as { items?: unknown }).items !== null

/**
 * A drop's files and folders, read now (the caller is inside the `drop` event). Items, not `files`: a
 * string item (a dragged link's text) has no file, so the two lists' indexes differ. A folder's own
 * `File` has a size and rejects every read (upload plan, Task 1), so it is told by its entry and only
 * named. No entry API (an older browser) or no entry: the item counts as a file, and a folder then fails
 * at its first read in the upload client, with a reason.
 */
export function splitTransfer(transfer: UploadTransferLike): { files: unknown[]; folders: string[] } {
  const files: unknown[] = []
  const folders: string[] = []
  const items = transfer.items
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (!item || item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    const file = item.getAsFile()
    if (entry?.isDirectory === true) {
      const name = typeof entry.name === 'string' ? entry.name : (file as { name?: unknown } | null)?.name
      if (typeof name === 'string') folders.push(name)
    } else if (file) files.push(file)
  }
  return { files, folders }
}

function uploadFolderOf(options: unknown, member: string): string {
  const folder = (options as { folder?: unknown } | null | undefined)?.folder
  if (typeof folder !== 'string') throw new TypeError(`upload.${member} needs { folder } (project-relative, '' the project folder)`)
  if (folder.length > MAX_UPLOAD_FOLDER_LENGTH) throw new RangeError(`upload.${member}: folder longer than ${MAX_UPLOAD_FOLDER_LENGTH}`)
  return folder
}

export interface PanelApi {
  /** Send to the plugin (JSON, at most 1 MiB as text). Queued until the page is connected. */
  post(message: JsonValue): void
  /** Hear what the plugin posts; returns the unsubscribe. */
  onMessage(listener: (message: JsonValue) => void): () => void
  /**
   * `listener` runs each time the page gets a new connection to its plugin after it was added: the
   * first one when added at script start, and for a page tab every later one too (its host
   * restarted, the browser reconnected, the link fell behind and was resynced: the frame is never
   * reloaded for those). Messages sent over the old connection may be lost and the plugin's side
   * starts over, so send it what the page holds there. Posts queued before the first connection go
   * out before it runs. Returns the unsubscribe.
   */
  onConnect(listener: () => void): () => void
  readonly theme: {
    /** The app's current theme (`vars` are the CSS variables already set on `:root`). */
    readonly current: PanelTheme | undefined
    onChange(listener: (theme: PanelTheme) => void): () => void
  }
  /** Set (a frozen object) once the shell says the page is a slot; undefined for a panel or an overlay. */
  readonly slot: SlotPageApi | undefined
  /** Set (a frozen object) once the shell says the page is a page tab; undefined anywhere else. */
  readonly tab: TabPageApi | undefined
  /** Where the page is drawn and who looks at it (a frozen object; `remote` and `access` are read-only). */
  readonly view: PanelViewApi
  /**
   * Upload files from the person's device (design-upload.md §5.2): only in a web access browser view
   * that is not a read guest's, once the page is connected; undefined elsewhere. A panel page's only.
   */
  readonly upload: PanelUploadApi | undefined
  /**
   * An html overlay's page has drawn what it shows: the app's loader over it goes. Needed only for
   * an overlay opened with `ready: 'manual'` (the default loader goes at load); harmless elsewhere.
   */
  ready(): void
  /**
   * The overlay's notes (an overlay opened with `notes: { key }`, perView): only in an overlay copy whose
   * app says so (its intro); undefined in a panel, slot, page tab, any other overlay and on an older app.
   */
  readonly notes: PanelNotesApi | undefined
  /** Ask Claude about the overlay's document: as `notes`, and never for a read-only guest. */
  readonly ask: PanelAskApi | undefined
  /** In an overlay copy: `discuss()` opens the app's Discuss popover (when the overlay shows Discuss). */
  readonly overlay: PanelOverlayApi | undefined
}

/** The fields of a DOM KeyboardEvent a chord is made of. */
export interface KeyLike {
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  repeat?: boolean
}

// A copy of chordFromEvent in src/shared/keys.ts (the canonical `ctrl+alt+shift+meta+key`), on
// purpose, as errorText below: a module main imports too would land in a shared chunk panel.js
// loads with `require`. The shell compares what this writes against its own table, so the two must
// agree; panel-core's unit test checks them against each other.
const UNSHIFTED: Readonly<Record<string, string>> = { '<': ',', '>': '.', '?': '/', ':': ';', '"': "'", '{': '[', '}': ']', '|': '\\', _: '-', '~': '`' }
const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  return: 'enter',
  spacebar: 'space',
  ' ': 'space',
  plus: '+',
  comma: ',',
  del: 'delete',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right'
}
const ownOf = (table: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined

/** The canonical chord of a key event (shared/keys.ts chordFromEvent), or null for a lone modifier. */
export function chordOfKey(e: KeyLike): string | null {
  if (typeof e.key !== 'string') return null
  let key = e.key.toLowerCase()
  if (key === 'control' || key === 'alt' || key === 'shift' || key === 'meta') return null
  const m = e.code ? /^(?:Key([A-Z])|Digit(\d))$/.exec(e.code) : null
  if (m) {
    const digit = m[2] !== undefined
    const asciiKey = /^[\x20-\x7e]$/.test(e.key)
    if (e.altKey || !asciiKey || (digit && (e.shiftKey || e.ctrlKey || e.metaKey))) key = (m[1] ?? m[2] ?? key).toLowerCase()
  }
  if (e.shiftKey) key = ownOf(UNSHIFTED, key) ?? key
  key = ownOf(KEY_ALIASES, key) ?? key
  const mods: string[] = []
  if (e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  if (e.metaKey) mods.push('meta')
  return [...mods, key].join('+')
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
  /** `ready()` came before the first port: said again, unmarked, when it comes (see `cc-plugin.ready` above). */
  private readyBeforePort = false
  private queue: string[] = []
  private readonly listeners = new Set<(message: JsonValue) => void>()
  private readonly themeListeners = new Set<(theme: PanelTheme) => void>()
  private theme: PanelTheme | undefined
  private applied: string[] = []
  private baseStyled = false
  private slotType: string | undefined
  private slotApi: SlotPageApi | undefined
  private tabApi: TabPageApi | undefined
  /** The last dirty state told to the shell (setDirty sends only a change). */
  private dirty = false
  /** The app's chords the page forwards (web shell; empty on the desktop, where main takes them). */
  private forwarded = new Set<string>()
  private readonly connectListeners = new Set<() => void>()
  /** From the shell's port message only (receive); nothing the page can call sets it. */
  private remote = false
  private access: 'owner' | 'read' | 'write' = 'owner'
  /** `ccPanel.upload`, made once; the getter shows it only while the view may upload. */
  private readonly uploadApi: PanelUploadApi
  /** An overlay copy's notes, Ask and Discuss (panel-overlay.ts): nothing until the shell's intro. */
  private readonly overlayCopy: OverlayCopyClient
  readonly api: PanelApi

  /**
   * `componentsCss` is the app's component stylesheet (src/sdk/components.css), installed at once
   * (then the scroll edges): unlike the scrollbars it does not wait for the theme message (it is on
   * macOS too, and a page should not draw its first frame with bare controls). Its colours are theme variables, which
   * resolve when the theme lands on `:root`.
   */
  constructor(
    private readonly root: ThemeRoot,
    private readonly warn: (message: string) => void = () => {},
    private readonly styles?: BaseStyles,
    componentsCss?: string,
    /** Where a slot page's size requests and `ready()` go: the parent window (the shell), in the browser. */
    private readonly toParent?: (message: {
      type: string
      height?: number
      width?: number
      dirty?: boolean
      chord?: string
      code?: string
      early?: true
      folder?: string
      files?: unknown[]
      folders?: string[]
    }) => void,
    /** macOS only: whether the bars are classic, which turns the scrollbar sheet on (see installBaseStyles). */
    private readonly classicBars?: ClassicBarsWatch,
    /** The page's file chooser for `ccPanel.upload.pick` (panel.ts); without one, pick only warns. */
    private readonly chooseFiles?: UploadChooser
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
    // The edge fade goes on at once, on every platform (macOS too); only the bars wait for the
    // theme, which says whether this is macOS.
    if (styles) {
      try {
        styles.install(SCROLL_EDGES_CSS)
      } catch (err) {
        this.warn(`could not install the scroll edges: ${errorText(err)}`)
      }
    }
    // A getter with no setter on a frozen object: the page reads what the shell said and cannot
    // write it (an assignment throws in strict code and is ignored otherwise).
    const view = {}
    Object.defineProperty(view, 'remote', { enumerable: true, get: (): boolean => this.remote })
    Object.defineProperty(view, 'access', { enumerable: true, get: (): 'owner' | 'read' | 'write' => this.access })
    const api = {
      post: (message: JsonValue) => this.post(message),
      onMessage: (listener: (message: JsonValue) => void) => this.onMessage(listener),
      onConnect: (listener: () => void) => this.onConnect(listener),
      theme: Object.freeze(theme) as PanelApi['theme'],
      view: Object.freeze(view) as PanelViewApi,
      ready: (): void => this.ready()
    }
    // A getter: the page learns it is a slot after load, and `slot` must then appear on the same object.
    Object.defineProperty(api, 'slot', { enumerable: true, get: (): SlotPageApi | undefined => this.slotApi })
    Object.defineProperty(api, 'tab', { enumerable: true, get: (): TabPageApi | undefined => this.tabApi })
    this.uploadApi = Object.freeze({
      pick: (options: { folder: string }): void => this.pickUpload(options),
      files: (source: UploadFilesSource, options: { folder: string }): void => this.filesUpload(source, options)
    })
    // A getter: the shell says remote and access with the port, after the page's script started. The
    // desktop and a read guest's view get none, so a page that tests for it offers nothing there (main
    // refuses by the view it bound anyway).
    Object.defineProperty(api, 'upload', {
      enumerable: true,
      get: (): PanelUploadApi | undefined =>
        // Not in a slot or a page tab: the shell takes a panel frame's upload only (a post from those is dropped).
        this.remote && this.access !== 'read' && !this.slotApi && !this.tabApi ? this.uploadApi : undefined
    })
    this.overlayCopy = new OverlayCopyClient(
      (text) => this.postText(text),
      (m) => this.warn(m),
      () => this.access,
      MAX_PANEL_MESSAGE_LENGTH
    )
    // Getters: the shell's intro comes after the page's script started (with the port).
    Object.defineProperty(api, 'notes', { enumerable: true, get: (): PanelNotesApi | undefined => this.overlayCopy.notes })
    Object.defineProperty(api, 'ask', { enumerable: true, get: (): PanelAskApi | undefined => this.overlayCopy.ask })
    Object.defineProperty(api, 'overlay', { enumerable: true, get: (): PanelOverlayApi | undefined => this.overlayCopy.overlay })
    this.api = Object.freeze(api) as PanelApi
  }

  /** A message from the parent window (the bootstrap checked its source). */
  receive(data: unknown, ports: readonly PortLike[]): void {
    const type = (data as { type?: unknown } | null)?.type
    if (type === PORT_MESSAGE && ports[0]) {
      // Before the port is connected: a message the host sent first may already be waiting on it.
      this.remote = (data as { remote?: unknown }).remote === true
      // Anything but a guest role is the owner's view: the hint can only hide more, never grant anything.
      const access = (data as { access?: unknown }).access
      this.access = access === 'read' || access === 'write' ? access : 'owner'
      this.connect(ports[0])
    }
    else if (type === SLOT_MESSAGE) this.becomeSlot((data as { slot?: { type?: unknown } }).slot?.type)
    else if (type === TAB_MESSAGE) {
      this.becomeTab((data as { tab?: { type?: unknown } }).tab?.type)
      this.setForwarded((data as { keys?: unknown }).keys)
    }
    else if (type === KEYS_MESSAGE) this.setForwarded((data as { keys?: unknown }).keys)
    // Only a frame the shell drew as an overlay copy: a slot or a page tab never becomes one.
    else if (type === OVERLAY_INTRO_MESSAGE) {
      if (this.slotApi === undefined && this.tabApi === undefined) this.overlayCopy.intro((data as { overlay?: unknown }).overlay)
    }
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

  /** The shell says this page is a page tab; the first message wins (a tab's type does not change). */
  private becomeTab(type: unknown): void {
    if (this.tabApi !== undefined || typeof type !== 'string' || !SLOT_TYPE.test(type)) return
    this.tabApi = Object.freeze({
      type,
      setDirty: (dirty: boolean): void => {
        if (typeof dirty !== 'boolean') throw new TypeError('tab.setDirty needs a boolean')
        if (dirty === this.dirty) return
        this.dirty = dirty
        this.toParent?.({ type: TAB_DIRTY_MESSAGE, dirty })
      },
      discuss: (): void => this.toParent?.({ type: TAB_DISCUSS_MESSAGE })
    })
  }

  /**
   * The app's chords as the shell listed them (a page tab's intro, or `cc-plugin.keys` to a panel or slot in
   * the web shell); anything else in the list is dropped. The message only comes from the parent window.
   */
  private setForwarded(raw: unknown): void {
    if (!Array.isArray(raw)) return
    const next = new Set<string>()
    for (const chord of raw.slice(0, MAX_FORWARDED_KEYS)) {
      if (typeof chord === 'string' && chord.length > 0 && chord.length <= MAX_CHORD_LENGTH) next.add(chord)
    }
    this.forwarded = next
  }

  /**
   * A key pressed in the page (panel.ts listens in the capture phase, before the page's own
   * handlers). An app chord the shell listed is the app's: the page never handles it (`true`: the
   * caller stops the event) and the shell runs its command. Auto-repeats are stopped but not sent,
   * as the shell runs no command per repeat.
   */
  keyDown(e: KeyLike): boolean {
    if (this.forwarded.size === 0) return false
    const chord = chordOfKey(e)
    if (chord === null || !this.forwarded.has(chord)) return false
    if (!e.repeat) this.toParent?.({ type: TAB_KEY_MESSAGE, chord, ...(typeof e.code === 'string' ? { code: e.code } : {}) })
    return true
  }

  /**
   * The page's window got the focus (panel.ts listens on `focus`): a page tab tells the shell, which
   * then checks whether the keyboard may stay here (design-split-pages.md §4). Nothing else posts.
   */
  windowFocused(): void {
    if (this.tabApi !== undefined) this.toParent?.({ type: TAB_FOCUS_MESSAGE })
  }

  private connect(port: PortLike): void {
    if (this.port) {
      // What was asked on the old port gets no answer there.
      this.overlayCopy.reset('the connection to the app was replaced')
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
    // A ready() before the port: the shell attached this load when it posted the port, so this one is this load's
    // (second codex review, finding 4: an early ready went to the previous load's copy and this one's loader stayed).
    if (this.readyBeforePort) {
      this.readyBeforePort = false
      this.toParent?.({ type: READY_MESSAGE })
    }
    // Every new connection, so a page tab (whose frame is never reloaded to get one) can re-send.
    for (const listener of [...this.connectListeners]) {
      try {
        listener()
      } catch (err) {
        this.warn(`an onConnect listener threw: ${errorText(err)}`)
      }
    }
  }

  /** `ccPanel.upload.pick`: the chooser opens now, in the caller's gesture; the choice is posted when made. */
  private pickUpload(options: unknown): void {
    const folder = uploadFolderOf(options, 'pick')
    if (!this.chooseFiles) {
      this.warn('upload.pick: no file chooser in this page')
      return
    }
    // The browser enforces the gesture either way; the warning is for the page's author.
    const activation = (globalThis as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator?.userActivation
    if (activation?.isActive === false) this.warn('upload.pick: no user activation, so the browser opens no chooser (call it inside a click or key handler)')
    this.chooseFiles((files) => {
      if (files.length > 0) this.postUpload(folder, files, [])
    })
  }

  /** `ccPanel.upload.files`: everything read before the call returns (a drop's items die with the event). */
  private filesUpload(source: unknown, options: unknown): void {
    const folder = uploadFolderOf(options, 'files')
    let files: unknown[]
    let folders: string[] = []
    if (isTransfer(source)) ({ files, folders } = splitTransfer(source))
    else if (typeof source === 'object' && source !== null && typeof (source as { length?: unknown }).length === 'number') {
      files = Array.from(source as ArrayLike<unknown>).filter((f) => typeof f === 'object' && f !== null)
    } else throw new TypeError('upload.files needs a DataTransfer, a FileList or an array of Files')
    if (files.length === 0 && folders.length === 0) {
      this.warn("upload.files: nothing to upload (pass a drop's DataTransfer inside the drop event)")
      return
    }
    // Folders alone are posted too: core says they were skipped, rather than nothing happening.
    this.postUpload(folder, files, folders)
  }

  private postUpload(folder: string, files: unknown[], folders: string[]): void {
    this.toParent?.({ type: UPLOAD_MESSAGE, folder, files, folders })
  }

  /** `ccPanel.ready()`: marked `early` before the page's first port, and said again once it comes. */
  private ready(): void {
    if (this.port) {
      this.toParent?.({ type: READY_MESSAGE })
      return
    }
    this.readyBeforePort = true
    this.toParent?.({ type: READY_MESSAGE, early: true })
  }

  private post(message: JsonValue): void {
    if (hasEnvelopeKey(message)) throw new TypeError('post: a message may not have a top-level "$cc" key (it is reserved for the app)')
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
    this.postText(text)
  }

  /** One checked JSON text to the port, or to the bounded queue while there is none; false: dropped. */
  private postText(text: string): boolean {
    if (this.port) {
      this.port.postMessage(text)
      return true
    }
    if (this.queue.length >= MAX_QUEUED_MESSAGES) {
      this.warn(`post: not connected and ${MAX_QUEUED_MESSAGES} messages are waiting; this one is dropped`)
      return false
    }
    this.queue.push(text)
    return true
  }

  private onConnect(listener: () => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('onConnect needs a function')
    // Wrapped, as onMessage's: the same function added twice is two listeners.
    const entry = (): void => listener()
    this.connectListeners.add(entry)
    return () => {
      this.connectListeners.delete(entry)
    }
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
    // An overlay copy's port: an envelope is the app's answer or push (the shell refuses one a page posts, the host
    // and main one a plugin posts), never the plugin's message.
    if (this.overlayCopy.isCopy && isEnvelope(parsed)) {
      this.overlayCopy.receive(parsed as unknown as Record<string, unknown>)
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

  /**
   * The bar sheet, once, on the first theme. On macOS it is on only while the page's own bars are
   * classic (a mouse connected and "Show scroll bars" on Automatic, or Always): overlay bars already
   * hide at rest, and the sheet would turn them classic. The page measures its own document, and the
   * sheet keeps its place while off. With no way to measure or to switch it, macOS gets no sheet.
   */
  private installBaseStyles(mac: boolean): void {
    const styles = this.styles
    if (this.baseStyled || !styles) return
    if (mac && (!this.classicBars || !styles.enable)) return
    this.baseStyled = true
    try {
      styles.install(BASE_SCROLLBAR_CSS)
      if (!mac) return
      const enable = styles.enable!.bind(styles)
      enable(BASE_SCROLLBAR_CSS, false)
      this.classicBars!((classic) => {
        try {
          enable(BASE_SCROLLBAR_CSS, classic)
        } catch (err) {
          this.warn(`could not switch the base styles: ${errorText(err)}`)
        }
      })
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
