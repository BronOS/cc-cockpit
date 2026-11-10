// The public plugin API, version 1 (design §5 › Host API). A plugin's `main` module exports
// `activate(ctx: PluginContext)` and, optionally, `deactivate()`. `ctx` is already scoped to ONE
// project window: nothing in it takes a project id, and the ids it does take (a tab, a panel) are
// only looked up inside that project by main.
//
// This file is types only, so a plugin author can depend on it without pulling in app code. A
// later minor release may add members; a breaking change bumps PLUGIN_API_VERSION, and the app
// refuses a manifest whose `api` major it does not know (src/shared/manifest.ts).
//
// The phase-1 host implements every member (src/host/ctx/). The page side of panels is the panel SDK
// (src/sdk/panel.ts, loaded as `../__sdk/panel.js` from a page one folder deep: a URL relative to
// the page, never root-absolute, which breaks over web access). A page that loads it also gets the
// app theme on `:root` and the app's component stylesheet (`.cc-btn`, `.cc-row`, `.cc-field`, ...;
// `ccc guide style`), adopted first and inside `@layer cc`, so any rule of the page's own wins over it.

export const PLUGIN_API_VERSION = 1

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Undo a registration (a listener, a schedule, a command). Calling it twice is harmless. */
export type Disposer = () => void

/** The plugin's settings, validated against the manifest's JSON Schemas with defaults applied. */
export interface PluginSettings {
  /**
   * This project's values (`contributes.settings.project`): per top-level field, the project's
   * override, else the global value (set on the plugin's global settings page), else the schema
   * default. An object field is overridden whole.
   */
  readonly project: Readonly<Record<string, JsonValue>>
  /** App-wide values (`contributes.settings.app`). */
  readonly app: Readonly<Record<string, JsonValue>>
}

/**
 * Per plugin, per project key-value store. Values are JSON. Keys are non-empty strings of at most
 * 200 characters; a value is at most 1 MiB as JSON; 16 MiB per plugin and project in total (no
 * separate key count). A write past a limit rejects with a RangeError and stores nothing.
 */
export interface PluginStorage {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

/**
 * Per plugin, APP-WIDE key-value store: the hosts of every project window see the same keys (an
 * app-wide quota, a cache shared by all projects). Main owns it and applies one call at a time, so
 * `increment` is atomic across windows; a `get` then `set` is not (another window can write in
 * between). Keys are non-empty strings of at most 200 characters; a value is at most 1 MiB less 8
 * KiB as JSON (it travels in one message to main); 16 MiB per plugin in total. Kept when the
 * plugin is uninstalled.
 */
export interface PluginAppStorage {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | undefined>
  set(key: string, value: JsonValue): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
  /**
   * Adds `by` (default 1; a finite number, negative to subtract) to the number stored under `key`
   * (absent counts as 0), stores it and resolves the new value. Rejects when the stored value is
   * not a number.
   */
  increment(key: string, by?: number): Promise<number>
}

/**
 * This plugin's secrets (tokens, passwords), encrypted by main with the OS keychain. APP-WIDE per
 * plugin, unlike `storage`: every project sees the same keys, so a plugin with per-project
 * sign-ins names its keys itself (`google:work`) and lets a project setting pick one. Keys match
 * `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`; values are strings of at most 64 KiB; at most 100 keys.
 * Keys starting with `setting:` belong to the plugin's secret settings fields: readable, never
 * written or deleted here, and not listed by `keys()`. Other plugins enabled in the same project
 * share its host and can reach this store too (design §6 trust boundary).
 */
export interface PluginSecrets {
  /** The value, or null when not set. Rejects when the stored value cannot be decrypted. */
  get(key: string): Promise<string | null>
  /** Encrypts and stores; rejects when the OS cannot encrypt (plaintext is never stored). */
  set(key: string, value: string): Promise<void>
  /** Removes the key; an unknown key is not an error. */
  delete(key: string): Promise<void>
  /** Keys this plugin has set, sorted. */
  keys(): Promise<string[]>
}

/**
 * An OAuth 2.0 client for `ctx.oauth` (authorization code + PKCE, RFC 6749 / 7636 / 8252). Both URLs
 * must be https (no exception, not even 127.0.0.1) and hold no user:password. The auth URL may
 * carry the provider's own query parameters (Google: `access_type=offline&prompt=consent`, without
 * which it sends no refresh token); main's own (response_type, client_id, redirect_uri, state,
 * PKCE, and scope when `scopes` is non-empty) replace any of the same name, and one named
 * `client_secret` is refused. With `scopes: []` the auth URL's own `scope` (or the provider's
 * default) stands. The client secret, if any, goes only in the POST body to `tokenUrl`, never
 * into the browser.
 */
export interface OAuthSpec {
  authUrl: string
  tokenUrl: string
  /** 1 to 500 characters. */
  clientId: string
  /** At most 4096 characters; empty means none. Keep it in a secret settings field. */
  clientSecret?: string
  /** At most 50, each 1 to 256 printable ASCII characters with no space, quote or backslash. */
  scopes: string[]
}

/** What the token endpoint granted. Storing it (with `ctx.secrets`) is the plugin's job. */
export interface OAuthTokens {
  /** A bearer token (other token types are refused). */
  accessToken: string
  /**
   * The refresh token, or null when the provider sent none. After `refresh`, null means the
   * provider did not rotate it: keep the one you have.
   */
  refreshToken: string | null
  /** When the access token expires, ms since the epoch (counted from when the request was sent). */
  expiresAt: number
  /**
   * The scopes the provider says it granted (its `scope` answer, split on spaces); absent when it
   * sent none. The person may untick a scope on the consent page, so check for one you need.
   */
  scope?: string[]
}

export interface PluginOAuth {
  /**
   * Opens the system browser on the provider's sign-in page, waits for its redirect to a loopback
   * server on 127.0.0.1 and exchanges the code. Rejects when the user does not finish within 5
   * minutes, the provider refuses, the spec is invalid (before any browser opens), another
   * `authorize` of this plugin is still pending, or after 5 in a minute (per project window). A
   * pending one is cancelled when the plugin host stops or the window closes.
   */
  authorize(spec: OAuthSpec): Promise<OAuthTokens>
  /**
   * Exchanges a refresh token for a fresh access token (`invalid_grant` in the error: sign in
   * again). At most 4 in flight per plugin; more reject.
   */
  refresh(spec: OAuthSpec, refreshToken: string): Promise<OAuthTokens>
}

export interface ExecOptions {
  /** Written to the process's stdin, which is then closed. */
  stdin?: string
  /** An existing directory; defaults to the project folder, a relative path is relative to it. */
  cwd?: string
  /** Killed (with its whole process group) after this long. Default 60 000, at most 600 000. */
  timeoutMs?: number
}

export interface ExecResult {
  /**
   * Exit code; null when killed by a signal (or the timeout). A non-zero code resolves; the call
   * rejects when the program cannot be started or writes more than 10 MiB (stdout and stderr
   * together).
   */
  code: number | null
  stdout: string
  stderr: string
}

export type BadgeValue = number | 'dot' | null

/**
 * An icon button in a panel's title bar (ctx.panels.header). `icon` is one of the app's own icons
 * (`refresh`, `add`, `search`, `filter`, `settings`, `open-external`, `check`, `sort`) or a path to
 * an `.svg` inside the plugin folder (drawn in the header's colour, like a panel icon).
 */
export interface PanelHeaderAction {
  /** 1 to 40 of `A-Z a-z 0-9 . _ -`, unique in the header: what `onAction` gets on a click. */
  id: string
  icon: string
  /** Tooltip and accessible name, at most 80 characters. */
  title: string
  /** The icon spins and clicks are ignored (a refresh under way). */
  busy?: boolean
  disabled?: boolean
}

/**
 * How big an overlay is drawn: `default` a centered dialog (75 % of the window), `large` about 90 %,
 * `full` the whole window below the top bar with a small margin. Every size keeps the title bar and
 * the close button. A terminal overlay's program is resized to fit.
 */
export type OverlaySize = 'default' | 'large' | 'full'

/**
 * What an overlay says about itself, on top of its kind (every kind takes these). An older app
 * ignores keys it does not know, so check `typeof ctx.overlay.buttons === 'function'` before you
 * rely on buttons from other plugins.
 */
export interface OverlayExtras {
  /**
   * What the overlay shows: `name` a plain noun (`^[a-z][a-z0-9-]{0,63}$`), `data` plain JSON of at
   * most 4,096 characters. Other plugins' buttons are chosen by the name, and Discuss with Claude
   * names it. Well-known: `file` `{ path, mime? }` (path relative to the project folder) and
   * `inbox-item` `{ source, id }` (`source` the providing plugin's id).
   */
  type?: { name: string; data: JsonValue }
  /** The opener's own buttons in the overlay's toolbar, at most 4; clicks reach `onButton`. */
  buttons?: OverlayButton[]
  /**
   * html only (refused for another kind): when the loader goes. `'load'` (default): once the page
   * has loaded and its port is up. `'manual'`: when the page calls `ccPanel.ready()`, for an opener
   * that fetches first and posts the content after.
   */
  ready?: 'load' | 'manual'
  /**
   * Discuss with Claude: `{ tabId }` preselects that Claude tab of this window; `false` hides the
   * button on this overlay. Absent: shown for an overlay with a `type` or an `onDiscuss` handler.
   */
  discuss?: { tabId?: string } | false
}

/** A button in an overlay's toolbar. `id` 1-40 of `A-Z a-z 0-9 . _ -`; `label` 1-40 characters of plain text. */
export interface OverlayButton {
  id: string
  label: string
  /** A core icon name (as for `PanelHeaderAction`) or a plugin-relative `.svg` path. */
  icon?: string
  primary?: boolean
  disabled?: boolean
  /** Shown as under way; clicks are ignored. */
  busy?: boolean
}

/** What a plugin that adds buttons for an overlay type is told about the overlay. */
export interface OverlayInfo {
  readonly type: { readonly name: string; readonly data: JsonValue }
  readonly title: string
  /**
   * The opening plugin's id, `'core'` or `'cli'`. Set by the app from the plugin whose request it
   * accepted (never from the spec or its `type.data`), so a provider can trust it where it cannot
   * trust `data`: a source adds its `inbox-item` buttons only on overlays it or the reviewer it handed
   * the item to opened, so another plugin naming a thread of yours gets none. Plugins of one project
   * share a JS realm, so this keeps out mistakes and opportunists, not deliberate impersonation.
   */
  readonly opener: string
}

/** A button another plugin adds to every overlay of a type; `run` gets the overlay's info on a click. */
export interface OverlayTypeButton extends OverlayButton {
  run: (overlay: OverlayInfo) => unknown | Promise<{ close?: true } | void>
}

export type OverlaySpec =
  | ({ kind: 'terminal'; argv: string[]; cwd?: string; title?: string; size?: OverlaySize } & OverlayExtras)
  | ({ kind: 'url'; url: string; title?: string; size?: OverlaySize } & OverlayExtras)
  /**
   * One of the plugin's own pages (plugin-relative path), loaded like a panel: the plugin's CSP,
   * the app theme and the panel SDK. The page answers with `ccPanel.post({ result: value })`,
   * which closes the overlay and resolves `open` with `{ kind: 'value', value }`. With
   * `overlay.start`, anything else it posts (no `result` key) goes to the handle's `onMessage`.
   */
  | ({ kind: 'html'; file: string; title?: string; size?: OverlaySize } & OverlayExtras)

export type OverlayResult =
  | { kind: 'exit'; code: number }
  | { kind: 'value'; value: JsonValue }
  | { kind: 'dismissed' }
  /** The person used Discuss with Claude: the text went to Claude tab `tabId` (`queued`: it waits for the tab to be ready). */
  | { kind: 'discussed'; tabId: string; queued: boolean }

/** Options of `ctx.notify(text, options)`. Unknown keys are ignored. */
export interface NotifyOptions {
  /** Plain text, 1 to 80 characters (longer rejects). Default: `cc-cockpit: <pluginId>`. */
  title?: string
  /**
   * A short sound from the project window (the same on every OS), unless the person turned off
   * "Notification sounds" (Settings > General > Notifications). At most one chime per
   * 5 s per window, however many plugins ask. The OS notification itself is then silent.
   * - `true`: the app's sound, the one picked there under "Sound".
   * - a string: the value of one of this plugin's `"format": "sound"` settings fields, as it is
   *   (`""`, the field's "App default", is `true`). The app rings it only when it is one of its own
   *   sounds now (a built-in, or a system sound file still listed); otherwise the app's sound, logged
   *   once. A plugin never names a file. At most 1024 characters (longer rejects).
   * - `false` or absent: no sound.
   */
  sound?: boolean | string
  /**
   * Make the notification clickable and wait for it: the call resolves `{ clicked: true }` when the
   * person clicks it (or its button, shown with this label on macOS and Windows; 1 to 40
   * characters), `{ clicked: false }` when it is dismissed, after 10 minutes (it is then closed),
   * or when the plugin deactivates. On Linux and Windows it stays on screen until then. What a
   * click does is up to the plugin (e.g. `ctx.openExternal(link)`, which has its own limit).
   */
  action?: { label: string }
}

/** What `ctx.notify` resolves with. Without an `action`, always `{ clicked: false }`, once shown. */
export interface NotifyResult {
  clicked: boolean
}

/** An overlay opened with `ctx.overlay.start`, while it is open. */
export interface OverlayHandle {
  /** What `ctx.overlay.open` resolves with: the page's result, an exit code, or dismissed. */
  readonly result: Promise<OverlayResult>
  /**
   * html only (throws for another kind): send JSON to the page, where `ccPanel.onMessage` hears
   * it. Queued until the page has loaded. At most 1,040,384 chars of JSON (1 MiB less 8 KiB for
   * the transport); a larger one throws a RangeError. A no-op once the overlay ended.
   */
  post(message: JsonValue): void
  /**
   * html only (throws for another kind): hear what the page posts without a `result` key (the
   * overlay stays open). Listeners are dropped when the overlay ends.
   */
  onMessage(listener: (message: JsonValue) => void): Disposer
  /** Dismiss the overlay (`result` resolves `{ kind: 'dismissed' }`). A no-op once it ended. */
  close(): void
  /**
   * Bring the overlay to the front of the window's overlay stack (it shows and takes the keyboard;
   * the others stay open under it), e.g. on a second click for something already open. A no-op
   * once it ended.
   */
  focus(): void
  /** A click on one of the buttons the spec (or `setButtons`) gave, by its `id`. Dropped when the overlay ends. */
  onButton(id: string, handler: () => unknown): Disposer
  /** Replace the opener's buttons (a "Mark read" that became "Mark unread"). Same rules as `buttons` in the spec. A no-op once the overlay ended. */
  setButtons(buttons: OverlayButton[]): void
  /**
   * Answer Discuss with Claude with the context text to send (within 5 s), or `null` for none. A
   * throw or a timeout shows its error to the person and sends nothing.
   */
  onDiscuss(handler: () => Promise<{ text: string } | null> | { text: string } | null): Disposer
  /**
   * Draw Discuss with Claude as the toolbar's primary (accent) button, or plain again with `false`
   * (the default): e.g. once the page holds something worth sending. Held until the overlay exists;
   * a no-op once it ended or while Discuss is not shown. An older app has no such method.
   */
  setDiscussPrimary(on: boolean): void
}

export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs-permission' | 'waiting' | 'ended'

/** One Claude tab of this project window. */
export interface SessionInfo {
  readonly tabId: string
  readonly status: SessionStatus
  readonly cwd: string
  readonly sessionId?: string
  readonly tool?: string
  /** The person's last prompt, Claude Code's own markup (system reminders, task notifications) taken out. */
  readonly lastPrompt?: string
  /**
   * The short topic Claude Code put in the terminal title (`Greeting in two words`), spinner glyph
   * removed; what the Sessions panel and the tab strip name the tab. Absent until Claude has one.
   */
  readonly title?: string
  /** The name the person (or a plugin, `ctx.sessions.rename`) gave the tab; shown instead of `title`. */
  readonly name?: string
  /**
   * A one-line summary of the session (the app's "Session gist" setting, a short model run after each
   * turn); absent while the setting is off or before the first one. An older app never sends it.
   */
  readonly gist?: string
  readonly notes: readonly string[]
  readonly steps?: { readonly done: number; readonly total: number }
  /**
   * Files the tab's Claude wrote (Write, Edit, MultiEdit, NotebookEdit), each once, in the order
   * first written, as Claude gave them: absolute paths, files outside the project included. Kept
   * for the tab's life, at most 500 (later ones are not added). A click on one in the Sessions
   * panel reaches `ctx.files.onOpen` only for files inside the project; others open in the
   * built-in viewer.
   */
  readonly files: readonly string[]
  /**
   * `true` for the tab the project window shows (selected in its tab pane): "the tab the person
   * is looking at". Absent on every other tab, and on all of them while a shell tab is selected.
   * A selection change reaches `onChange` like any other change (throttled). Selection only: the
   * window itself may be in the background.
   */
  readonly active?: boolean
  /**
   * `true` once the person typed or pasted into the tab's terminal: they took it over. Set on the
   * first key or paste (a key before Enter counts), never by terminal reports the terminal sends by
   * itself (focus on switching to the tab, mouse clicks and scrolls, replies to queries), nor by
   * `ctx.sessions.send` or anything else the app types. Never cleared while the tab exists (a
   * restart keeps it); not persisted, so a tab restored at app start is `false`. The flip reaches
   * `onChange`. Always present on an app that detects it: an older app has no such field.
   */
  readonly typed: boolean
  /**
   * The person's flag on the tab: they marked it to come back to. `color` is one of `red`,
   * `orange`, `yellow`, `green`, `blue`, `purple` (theme tokens `--cc-flag-<color>` in panel pages);
   * `note` an optional reminder, 1 to 80 characters of plain text. Absent when the tab has none.
   * Read-only: only the person sets or clears it (the tab's right-click menu, the Toggle Tab Flag
   * command), no plugin API writes it. Sticky until cleared, kept across an app restart; a change
   * reaches `onChange`. An older app never sends it.
   */
  readonly flag?: { readonly color: string; readonly note?: string }
  /**
   * What the session has cost so far in USD (Claude Code's `cost.total_cost_usd`), from the tab's
   * status line (the app setting "Rate limits from the status line"). Absent before Claude's first
   * status line, when the setting is off, and once the tab's process ended. An older app never sends it.
   */
  readonly costUsd?: number
  /**
   * How full the session's context window is, 0-100 (Claude Code's `context_window.used_percentage`),
   * from the status line like `costUsd` and absent in the same cases.
   */
  readonly contextPercent?: number
}

/**
 * One Claude tab of any window (`ctx.sessions.list({ scope: 'all' })`, which needs the manifest's
 * `"access": { "sessions": "all-windows" }`). Only what tells the tabs apart and what they are doing:
 * never prompts, notes, files, cwd or terminal content.
 */
export interface SessionSummary {
  readonly tabId: string
  /** A tab of the caller's own window; its full `SessionInfo` is in `list()`. */
  readonly own: boolean
  /**
   * The tab's project: its name, and its colour as a CSS value when it has one (`var(--cc-project-blue)`
   * for a palette colour, a theme token panel pages have; `#rrggbb` for a custom one).
   */
  readonly project: { readonly name: string; readonly color?: string }
  readonly status: SessionStatus
  readonly tool?: string
  readonly title?: string
  /** The name the person gave the tab; shown instead of `title`. */
  readonly name?: string
  /** The person's flag colour (SessionInfo.flag without its note, which stays in the tab's own window). */
  readonly flag?: { readonly color: string }
}

/** One rate-limit window of the person's Claude account (`RateLimits`). */
export interface RateLimitWindow {
  /** How much of the window is used, 0-100. */
  readonly usedPercent: number
  /** When the window resets, epoch milliseconds. */
  readonly resetsAt: number
}

/**
 * The person's Claude plan usage (`ctx.sessions.rateLimits`): account-wide, the latest any Claude tab
 * of any window reported through its status line. A window is absent when Claude Code did not report
 * it (an API-key login has none) or stopped reporting it. A window past its reset is dropped at the
 * next report, not at the reset itself: compare `resetsAt` with the clock and skip an expired one.
 */
export interface RateLimits {
  /** The 5-hour window (Claude Code's `rate_limits.five_hour`). */
  readonly fiveHour?: RateLimitWindow
  /** The 7-day window (`rate_limits.seven_day`). */
  readonly sevenDay?: RateLimitWindow
  /** When main last heard a report, epoch milliseconds. */
  readonly updatedAt: number
}

/** `delivered`: typed now (the tab was waiting for input); `queued`: sent at its next Stop. */
export type SendResult = { readonly delivered: true } | { readonly queued: true; readonly itemId: string }

/** What a `ccc <name>` handler gets besides its arguments. */
export interface CliCall {
  /**
   * The caller's stdin, read whole. Only for a command whose manifest entry sets `"stdin": true`
   * and only when stdin is not a terminal; `''` otherwise. At most 256 KiB once JSON-encoded.
   */
  readonly stdin: string
  /** The caller's working directory (absolute): resolve relative path arguments against it. */
  readonly cwd: string
  /**
   * The Claude tab that ran the command, set by the app from the caller's session token (never from its
   * arguments), so `ccc` in that tab cannot name another. Absent when the caller is a shell tab, a command
   * tab, a terminal overlay or outside a tab (`--project`), and on an app older than 0.11.
   */
  readonly tabId?: string
  /** Aborted when the call is cancelled: the caller pressed Ctrl+C, it timed out (30 s), or the plugin is deactivated. */
  readonly signal: AbortSignal
}

/**
 * What a `ccc <name>` handler answers. `stdout` and `stderr` are printed as they are (each cut at
 * 256 KiB once JSON-encoded), `code` is the exit code of `ccc` (an integer 0-255; default 0).
 */
export interface CliResult {
  stdout?: string
  stderr?: string
  code?: number
}

/** What a webview panel shows (`ctx.webview.current`, `onNavigate`). */
export interface WebviewPage {
  /** The page's URL: http(s), or `cc-preview://<token>/<file>` for a local file. */
  readonly url: string
  readonly title: string
  /**
   * Why the page failed to load (Chromium's `ERR_…` name and code, like
   * `ERR_CONNECTION_REFUSED (-102)`), absent for a page that loaded. The view then shows an empty
   * page at `url` and the toolbar the error; a reload tries again.
   */
  readonly error?: string
}

/**
 * A file the project opens with this plugin (`ctx.files.onOpen`): a click on a changed file in core's
 * Sessions panel, or a plugin's `ctx.files.open`. Both fields are checked by the app.
 */
export interface OpenFileRequest {
  /** The file, relative to the project folder (`src/app.ts`); never outside it. */
  readonly path: string
  /**
   * The Claude tab whose list of changed files was clicked, or the one a `ctx.files.open` caller
   * passed (an id `ctx.sessions` knows). Absent when the open did not come from a tab.
   */
  readonly tabId?: string
}

/** Where `ctx.files.open` sent the file: the project's open-file plugin, or the app's built-in viewer. */
export interface OpenFileResult {
  readonly via: 'plugin' | 'builtin'
}

export type CliHandler = (argv: string[], call: CliCall) => CliResult | void | Promise<CliResult | void>

export interface PluginLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** A placement of `ctx.panels.slots`: where in the panel's column, how tall, and what the provider is told. */
export interface SlotPlacement {
  /** `^[a-z][a-z0-9-]{0,63}$`; one of the panel's manifest `slots`. */
  type: string
  position: 'top' | 'bottom'
  /** Px, 24 to 600. */
  height: number
  /** Plain JSON, at most 4 KiB as JSON; only the provider sees it. */
  params?: JsonValue
}

/** One open frame of a slot this plugin provides (`ctx.slots.onOpen`). */
export interface SlotInstance {
  /** Opaque, one per frame. */
  readonly id: string
  readonly type: string
  /** What the frame sits in: another plugin's panel, or the app's top bar. */
  readonly host: { kind: 'panel'; pluginId: string; panelId: string } | { kind: 'app'; place: 'top-bar' }
  /** From the placement; untrusted for the provider (the placing plugin chose it). */
  readonly params: JsonValue | undefined
  /** JSON only, at most 1 MiB, to the slot's page (`ccPanel.onMessage`). Dropped once the frame closed. */
  post(message: JsonValue): void
  /** What the slot's page posts (`ccPanel.post`). */
  onMessage(listener: (message: JsonValue) => void): Disposer
  /** The frame ended: the host panel was hidden or reloaded, the placement removed, or the provider changed. */
  onClose(listener: () => void): Disposer
}

/**
 * One open html settings page of this plugin (`contributes.settings.page`, `ctx.settingsPage.onOpen`).
 * The page has no settings API of its own: store what it edits yourself (`ctx.appStorage` for the
 * app scope, `ctx.storage` for the project scope) and validate it. Never post secret values to it.
 */
export interface SettingsPageInstance {
  /** Which settings page shows it: the plugin's global page (`app`) or This project (`project`). */
  readonly scope: 'app' | 'project'
  /** JSON only, at most 1 MiB, to the page (`ccPanel.onMessage`). Dropped once the page closed. */
  post(message: JsonValue): void
  /** What the page posts (`ccPanel.post`). */
  onMessage(listener: (message: JsonValue) => void): Disposer
  /** The page went: Settings closed or moved on, the page reloaded, or another page of this plugin opened. */
  onClose(listener: () => void): Disposer
}

/** A theme's terminal palette (`ctx.themes.set`, the `xterm` object of a theme file). Colour strings. */
export interface XtermTheme {
  foreground?: string
  background?: string
  cursor?: string
  cursorAccent?: string
  selectionBackground?: string
  selectionForeground?: string
  selectionInactiveBackground?: string
  black?: string
  red?: string
  green?: string
  yellow?: string
  blue?: string
  magenta?: string
  cyan?: string
  white?: string
  brightBlack?: string
  brightRed?: string
  brightGreen?: string
  brightYellow?: string
  brightBlue?: string
  brightMagenta?: string
  brightCyan?: string
  brightWhite?: string
}

/**
 * A theme's contents for `ctx.themes.set`, the theme file format without `id`. Colours are `#rgb`,
 * `#rgba`, `#rrggbb`, `#rrggbbaa` or plain `rgb()`/`rgba()`/`hsl()`/`hsla()`; `vars` names are
 * `--name` CSS variables, at most 200 of them. Variables not set come from the built-in of `kind`.
 */
export interface PluginThemeInput {
  /** Omitted: the name the theme has now (from its file, or the last set). At most 100 characters. */
  name?: string
  kind: 'dark' | 'light'
  /** Omitted: none of its own (all from the built-in of `kind`). */
  vars?: Record<string, string>
  /** Omitted: none (the terminal's defaults). */
  xterm?: XtermTheme
}

export interface PluginContext {
  /** The API major this context implements. */
  readonly api: typeof PLUGIN_API_VERSION
  /** The plugin's manifest id. */
  readonly pluginId: string
  /**
   * The project folder: absolute, its real path (symlinks resolved), read when the host started
   * the plugin. The default cwd of `exec`. When the folder is missing at that moment (deleted or
   * on an unmounted volume), its nearest existing parent is resolved and the rest appended as is.
   */
  readonly projectDir: string

  // config
  readonly settings: PluginSettings
  onSettingsChange(listener: (settings: PluginSettings) => void): Disposer

  // data
  readonly storage: PluginStorage
  /** `<data>/plugin-data/<projectId>/<pluginId>/`, created the first time it is read. */
  readonly dataDir: string
  /** App-wide per plugin, held by main (see PluginAppStorage). */
  readonly appStorage: PluginAppStorage
  /** `<data>/plugin-data/_app/<pluginId>/`, the same in every project, created the first time it is read. */
  readonly appDataDir: string
  /** Encrypted, app-wide per plugin (see PluginSecrets). */
  readonly secrets: PluginSecrets
  /** An optional sign-in helper: browser, loopback redirect, PKCE, code exchange, refresh. */
  readonly oauth: PluginOAuth

  // work
  /**
   * Run `fn` every `seconds` (1 to 86 400; the first run is one interval from now). A run still in
   * progress skips the tick; a run over 60 s is abandoned and reported; an error shows as ⚠ on
   * the plugin's panels. Cleared on deactivate.
   */
  schedule(seconds: number, fn: () => unknown): Disposer
  /** Run argv (never through a shell); argv[0] is looked up on the login-shell PATH. */
  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>

  // UI
  /**
   * This plugin's own panels; `panelId` must be declared in the manifest (throws otherwise).
   * `post` and `onMessage` message an html panel (they throw for a `webview` panel: it has no page
   * of the plugin's to talk to); `show` works for both kinds.
   */
  readonly panels: {
    /**
     * JSON only, at most 1 MiB. Dropped while the panel is not shown (it asks again when it connects).
     * With no `options` the message goes to the panel's page in every view (the desktop window and
     * each browser showing the project): right for state pushes. `{ view }` (the `view` a listener
     * got) sends to that one view's page: right for an answer to one page's request. A view that
     * has no page of the panel any more drops the message; a `view` that is not one throws.
     */
    post(panelId: string, message: JsonValue, options?: { view?: string }): void
    /**
     * The second argument says which page posted: `view` is `'desktop'` for the desktop window's own
     * page, else the id of a browser view (`web:<n>`). It stays valid for `post`'s `{ view }` after
     * the listener returned. Calls the listener makes (`ctx.sessions.focus`) already act in that view.
     */
    onMessage(panelId: string, listener: (message: JsonValue, from: { view: string }) => void): Disposer
    /**
     * Bring one of this plugin's own panels (either kind, a `webview` one included) into sight: a
     * hidden panel comes back, a closed one opens, its zone expands. Throws for an undeclared id;
     * a refusal from main is logged.
     */
    show(panelId: string): void
    /**
     * The title bar of one of this plugin's own panels (either kind): `meta` is muted plain text
     * after the title (at most 120 characters; cut with an ellipsis when it does not fit, the
     * whole text as tooltip), `actions` up to 3 icon buttons before the panel's "…" menu. Each
     * call replaces the whole header; null clears it back to the bare title. Throws for an
     * undeclared panel or a header over the limits; cleared when the plugin stops or reloads.
     */
    header(panelId: string, header: { meta?: string; actions?: PanelHeaderAction[] } | null): void
    /** A click on one of the panel's header actions (not a busy or disabled one): its `id`. */
    onAction(panelId: string, listener: (actionId: string) => void): Disposer
    /**
     * Place slots (pages another plugin draws) in the column of one of this plugin's own panels:
     * `position` is above (`top`) or below (`bottom`) the panel's own frame, `height` 24 to 600 px
     * (rounded and clamped, then clamped to the provider's `minHeight`/`maxHeight`), `params` plain
     * JSON of at most 4 KiB that only the provider sees. At most 4 placements; each `type` must be
     * in that panel's manifest `slots` and not an app slot type such as `sessions-strip`. Each call
     * replaces the whole set; `null` removes them. Who draws a type is the project's pick (none
     * while several plugins provide it and none is picked); the frames of a hidden or collapsed
     * panel are unmounted. Cleared when the plugin stops or reloads. Throws for an undeclared panel
     * or type or a placement over the limits; a refusal from main is logged.
     */
    slots(panelId: string, placements: SlotPlacement[] | null): void
  }
  /**
   * The provider side of slots: pages this plugin draws inside another plugin's panel or the
   * app's chrome. The types it can draw are the ones in its manifest `contributes.slots`.
   * Older apps have no `ctx.slots`: check `typeof ctx.slots === 'object'` first.
   */
  readonly slots: {
    /**
     * A frame of `type` opened (the page at the slot's `entry` is shown in it). Throws for a type
     * not in `contributes.slots`. Listeners are dropped when the plugin stops.
     */
    onOpen(type: string, listener: (slot: SlotInstance) => void): Disposer
    /**
     * For a plugin that places slots: would a placement of `type` draw now, i.e. a provider is
     * picked for this project and running. Asks the app, so it is a promise.
     */
    available(type: string): Promise<boolean>
  }
  /**
   * The backend of the plugin's html settings page (manifest `contributes.settings.page`), shown
   * under its schema form in Settings. One page of the plugin is open at a time.
   * Older apps have no `ctx.settingsPage`: check `typeof ctx.settingsPage === 'object'` first.
   */
  readonly settingsPage: {
    /**
     * The page opened in this project's window (its port is connected). Throws when the manifest
     * declares no `contributes.settings.page`. Listeners are dropped when the plugin stops.
     */
    onOpen(listener: (page: SettingsPageInstance) => void): Disposer
  }
  /**
   * Badge on one of this plugin's own panel icons: a count, a dot, or null to clear. Throws for a
   * panel the manifest does not declare; cleared when the plugin host stops.
   */
  badge(panelId: string, value: BadgeValue): void
  /**
   * The native web view of one of this plugin's own `"kind": "webview"` panels (throws for any other
   * panel id). The view is created on the first `navigate` and closed when the plugin deactivates.
   */
  readonly webview: {
    /**
     * Show an http(s) URL, or a local file given as an absolute path (resolve a relative one
     * yourself). A file is served read-only with the files next to it, through `cc-preview://`;
     * its CSP blocks fetch, images, frames and form posts to http(s), but not a navigation to an
     * http(s) URL carrying data, prefetch hints or WebRTC, so it is not off the network. Refused:
     * a dot-file, a file directly in the home folder (or above it, or `/`), in a shared temp
     * folder itself or a disk's top folder, inside any dot-folder (`~/.ssh`, a project's `.git`)
     * or ~/Library (`ccc guide webview` has the details). Links and redirects may go to http(s) and to the view's own
     * `cc-preview` pages; `window.open` goes to the system browser (3 per 10 s). At most 60 a
     * minute. Resolves once the page loaded (or after 10 s for a slow one); rejects when it failed
     * to load before that (no server on the port, a refused connection), with the error in the
     * message; `current()` then carries it too.
     */
    navigate(panelId: string, target: string): Promise<void>
    /** History and reload; no-ops before the first navigate. */
    back(panelId: string): Promise<void>
    forward(panelId: string): Promise<void>
    reload(panelId: string): Promise<void>
    /** What the view shows; empty strings before the first navigate; `error` after a failed load. */
    current(panelId: string): Promise<WebviewPage>
    /**
     * Called when the view commits a page (link, redirect, history), a load fails (`error`) or its
     * title changes; at most once per 100 ms (a burst reports its first and its last state). Url
     * and title are capped.
     */
    onNavigate(panelId: string, listener: (page: WebviewPage) => void): Disposer
  }
  readonly overlay: {
    /**
     * Resolves when the overlay ends (no timeout); dismissed when the plugin stops (its host stops,
     * or it is reloaded, disabled, updated or uninstalled: the new copy starts with none). At most 3
     * open at once and 10 per minute per plugin. A terminal's `cwd` is relative to the project
     * folder and must stay inside it; a url must be http or https.
     */
    open(spec: OverlaySpec): Promise<OverlayResult>
    /**
     * The same overlay as a handle (`open(spec)` is `start(spec).result`): an html page and the
     * plugin exchange messages while it is open. Esc, the close button and Cmd+Shift+W dismiss it
     * without asking the page, so a page that keeps a draft should post it as it goes.
     */
    start(spec: OverlaySpec): OverlayHandle
    /**
     * Add buttons to every overlay of type `typeName` in this window, whoever opened it (an "Edit"
     * on a `file`, a "Mark read" on your own `inbox-item`). When such an overlay opens, and again
     * after each click on any of its buttons and when its opener replaces its own, `provider` is
     * asked with the overlay's info and answers the buttons to show now (at most 4; `[]` for none).
     * It has 500 ms: a slower or throwing provider is skipped (logged in your plugin's log). The
     * info's data came from the opener, so check it (that an id is yours, that a path is inside the
     * project), and before a button that acts on an account, check `opener` too (OverlayInfo). A click calls that button's `run` (it shows busy until it settles, at most 30 s);
     * `{ close: true }` closes the overlay. Never reaches the overlay's page. Dropped when the plugin
     * stops. Check `typeof ctx.overlay.buttons === 'function'` first: an older app has none.
     */
    buttons(
      typeName: string,
      provider: (overlay: OverlayInfo) => OverlayTypeButton[] | Promise<OverlayTypeButton[]>
    ): Disposer
  }

  // sessions
  readonly sessions: {
    /**
     * This window's Claude tabs. `{ scope: 'all' }`: a summary of every window's Claude tabs instead,
     * only with the manifest's `"access": { "sessions": "all-windows" }` (throws otherwise). An older
     * app ignores the option and answers this window's tabs: check `typeof ctx.sessions.focus`.
     */
    list(options?: { scope?: 'window' }): Promise<SessionInfo[]>
    list(options: { scope: 'all' }): Promise<SessionSummary[]>
    /**
     * The whole list again whenever one of this window's Claude tabs changes (at most 4 per second).
     * `{ scope: 'all' }`: the summaries of every window whenever any Claude tab changes; the same
     * declaration as `list`.
     */
    onChange(listener: (sessions: SessionInfo[]) => void, options?: { scope?: 'window' }): Disposer
    onChange(listener: (sessions: SessionSummary[]) => void, options: { scope: 'all' }): Disposer
    /**
     * Select a Claude tab of any window, raising that window. False for an id that is no Claude tab
     * (any more). At most 10 in 10 s.
     */
    focus(tabId: string): Promise<boolean>
    /**
     * Close a Claude tab of this window the way the person would: a running tab asks first (the close
     * dialog, unless the person turned it off), in this window, which is raised for it. `closed: false`
     * when they cancel or the dialog could not be shown. Rejects for a tab of another window. At most 10 a minute.
     */
    close(tabId: string): Promise<{ closed: boolean }>
    /**
     * Open one of a tab's changed `files` (an entry of its `SessionInfo.files`, verbatim) as the person's
     * click would: the plugin picked to open files when it is inside the project, else the built-in
     * viewer. Rejects for a tab of another window and a path that is not in the tab's list. At most 20 in 10 s.
     */
    openFile(tabId: string, path: string): Promise<void>
    /**
     * Name a Claude tab of this window (`SessionInfo.name`), shown in the tab strip and the Sessions
     * panel instead of Claude's topic; `null` goes back to Claude's title. 1-60 characters without
     * control, bidi or invisible format characters (rejects otherwise), and for a tab of this window only. The name survives a
     * restart of the app. At most 30 a minute. An older app has no `rename`: check `typeof ctx.sessions.rename`.
     */
    rename(tabId: string, name: string | null): Promise<void>
    /**
     * The person's plan usage (`RateLimits`), the latest any Claude tab reported; null before the first
     * report, or when the app setting "Rate limits from the status line" is off and never was on since
     * the app started. Account-wide, so any plugin may read it. An older app has no `rateLimits`: check
     * `typeof ctx.sessions.rateLimits`.
     */
    rateLimits(): Promise<RateLimits | null>
    /** The usage again whenever a window's numbers change (at most one call per 2 s). */
    onRateLimits(listener: (rateLimits: RateLimits) => void): Disposer
    /**
     * Typed only while the tab is waiting for input; queued otherwise (delivered at a later Stop).
     * Rejects for a tab of another window, text starting with "/", "!", "#" or "&", and over 30 texts a minute.
     */
    send(tabId: string, text: string): Promise<SendResult>
    /**
     * A new Claude tab in this window; `cwd` must resolve inside the project folder, `prompt` is
     * passed as an argument, never typed (and may not start with "/", "!", "#" or "&"). At most 5 a minute.
     * `focus: true` also selects the new tab in this window (for a click the person made, such as
     * "Discuss in a new session"); without it the tab opens beside the one they are in, unselected.
     * `model` (`haiku`, `sonnet`, `opus` or `fable`) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`) start
     * the tab with `--model` / `--effort`; absent means the person's default, anything else rejects.
     * An older app ignores `focus`, `model` and `effort`.
     */
    open(options: { cwd?: string; prompt?: string; focus?: boolean; model?: string; effort?: string }): Promise<{ tabId: string }>
    /**
     * A plain shell tab in this window, the kind the person gets from "+" > shell: their login shell,
     * with no command, arguments or environment from the plugin and nothing typed into it. `cwd` must
     * resolve inside the project folder (the folder itself when absent). `focus: true` selects it (for
     * a click such as "Open terminal here"); without it the tab opens unselected. Counts against the
     * same 5 a minute as `open`. An older app has no `openShell`: check `typeof ctx.sessions.openShell`.
     */
    openShell(options?: { cwd?: string; focus?: boolean }): Promise<{ tabId: string }>
    /**
     * A command tab in this window running `argv` directly, with no shell: `argv[0]` is looked up on the
     * person's PATH and every element is one argument as is (1-64 strings of 1-4096 characters, no NUL).
     * Substituting a file name or other untrusted text is the plugin's job, and it must stay one whole
     * element; for a pipe, pass it as a positional argument: `['sh', '-c', 'glow "$1" | less -R', 'sh', file]`.
     * `cwd` resolves inside the project folder (the folder itself when absent); `title` is the tab's title,
     * 1-60 characters on one line (default: the last path part of `argv[0]`). The tab shows "Opened by
     * <plugin name> (<id>)". It is saved and comes back after a restart not started (the person's Restart
     * runs it), and is dropped once the plugin is uninstalled or revoked. A clean exit closes the tab under
     * the default `tabExit` setting, so to keep output on screen wrap the command so it waits for a key.
     * Unselected unless `focus: true`. Counts against the same 5 a minute as `open` and `openShell`.
     * An older app has no `openCommand`: check `typeof ctx.sessions.openCommand === 'function'`.
     */
    openCommand(options: { argv: string[]; cwd?: string; title?: string; focus?: boolean }): Promise<{ tabId: string }>
  }

  // commands
  readonly commands: {
    /** `id` must be declared in the manifest's `contributes.commands` (throws otherwise). */
    register(id: string, run: () => unknown): Disposer
  }

  // cli
  readonly cli: {
    /**
     * Implement `ccc <name> …`: `name` must be declared in the manifest's `contributes.cli` (throws
     * otherwise), one handler per name. `argv` is everything after the name, verbatim. A handler
     * that throws exits 1 with the message on stderr; one that runs past 30 s exits 124. At most 4
     * calls of this plugin run at once.
     */
    register(name: string, handler: CliHandler): Disposer
  }

  // files
  readonly files: {
    /**
     * Take over a click on a changed file in the Sessions panel, and every plugin's `files.open`.
     * Needs `contributes.openFile` in the manifest (throws otherwise). Opens come only when the
     * project uses this plugin to open
     * files: it is the only enabled one declaring `openFile`, or the one picked in Settings >
     * Plugins. Every listener is called; the app's built-in viewer opens instead when none is
     * registered, or each one throws or rejects within 1 s (a promise still pending then counts
     * as handled). The app waits at most 2 s for this host.
     */
    onOpen(listener: (req: OpenFileRequest) => unknown): Disposer
    /**
     * Open a project file the way a Sessions panel click does: with the plugin the project uses to
     * open files (its `onOpen` listener; it may be this plugin), else the built-in viewer (a diff
     * when git has one, else the file in a pager). `path` is relative to the project folder, with
     * `/` separators; it rejects for an absolute path, a `..` segment, a path whose real path
     * (symlinks resolved) is outside the project, a missing file or one that is not a regular file.
     * `options.tabId` is handed to the listener when it is a Claude tab of this project, else
     * dropped. Needs no manifest declaration; at most 20 calls per 10 s.
     */
    open(path: string, options?: { tabId?: string }): Promise<OpenFileResult>
    /**
     * Show a project file or folder selected in the system's file manager (Finder, Explorer, the
     * desktop's file manager on Linux). `path` as for `open`, and `''` is the project folder itself
     * (shown in its parent). Rejects for a path whose real path is outside the project or a missing
     * one. At most 3 per 10 s. Check `typeof ctx.files.reveal === 'function'`: an older app has none.
     */
    reveal(path: string): Promise<void>
    /**
     * Open a project file with the system's default app for its type, as a double click in the file
     * manager would. Rejects for what that would RUN instead of open: a folder (use `reveal`), a
     * file with an exec bit, an app bundle (`.app`) or anything inside one, and the runnable types
     * (`.command`, `.sh`, `.desktop`, `.AppImage`, `.exe`, `.bat`, `.ps1`, `.js`, `.jar` and the rest
     * listed in `ccc guide api`, any case). Same path rules as `reveal`; at most 3 per 10 s.
     */
    openWithSystem(path: string): Promise<void>
    /**
     * Move a project file or folder to the system Trash (Recycle Bin on Windows), recoverable; there
     * is no permanent delete. The app first asks the person in this window, naming the path relative
     * to the project: it resolves once moved, and rejects with an Error named `AbortError` when they
     * say no (nothing moved; show nothing). Rejects for the project folder itself, a path outside the
     * project by its real path, while another of this window's trash dialogs is open, and past 10 a
     * minute. A symlink is trashed as the link, never what it points to.
     */
    trash(path: string): Promise<void>
  }

  /**
   * Services between the plugins of one project (manifest `services`). Names must be declared:
   * `provide` only names in `services.provides`, `use` only names in `services.uses`.
   */
  readonly services: ServicesApi

  // misc
  /**
   * This plugin's own themes (manifest `contributes.themes`), changed while the app runs: a theme
   * that follows another app's palette. Older apps have no `ctx.themes`: check
   * `typeof ctx.themes === 'object'` first.
   */
  readonly themes: {
    /**
     * Replace the theme `themeId` (the un-namespaced manifest id) with `theme`, app-wide, in every
     * window: a full replacement, not a patch. Rejects for an id the manifest does not declare, a
     * theme whose file did not load, an invalid colour or name, over 32 KiB as JSON, and past 10
     * calls per 10 s per plugin and window. In memory only: the theme file is the starting value
     * again whenever the plugin loads (an app start, a reload or update), so set it in `activate`.
     * Setting what it already is changes nothing.
     */
    set(themeId: string, theme: PluginThemeInput): Promise<void>
  }
  /** Lines go to `<data>/logs/<pluginId>.log` (rotated at 5 MiB). */
  readonly log: PluginLogger
  /**
   * A system notification; text is cut at 500 characters, at most 10 per minute per plugin and
   * window (more reject). Only while the project's window is open (the host runs only then).
   * Without `options.action` it resolves once shown; with one it waits for a click (NotifyOptions).
   */
  notify(text: string, options?: NotifyOptions): Promise<NotifyResult>
  /**
   * Open a web page in the person's default browser, outside the app. `url` must be an http or
   * https URL of at most 2048 characters with no user name or password in it (`user:pass@`);
   * anything else rejects, and so does a call past 3 per 10 s per plugin and window. The URL is
   * normalized (`new URL(url).href`) before it is opened. Resolves once the app handed it to the
   * system; whether a browser then showed it is not reported. Use it on a person's click, not
   * unasked: a page opening by itself takes them out of what they were doing.
   */
  openExternal(url: string): Promise<void>
}

/**
 * A consumer's view of a service (`ctx.services.use`). Every property but `on` is an async method
 * of the provider: `await handle.search(q)`. The provider is resolved on each call, so the handle
 * keeps working across provider reloads and restarts. Arguments and results are copied as plain
 * data (structured clone): a function or symbol in them fails the call, a class instance arrives as
 * a plain object. A call waits for a still-activating provider; it rejects when no enabled plugin
 * provides the service, two do and none is picked in Settings > This Project, the major versions differ,
 * the provider failed to activate or never called `provide`, the method does not exist, or the
 * provider threw (a fresh Error with its message). There is no timeout: race your own.
 */
export type ServiceHandle = {
  /**
   * Listen for an event the selected provider `emit`s; returns the unsubscriber. Survives provider
   * reloads; dropped when this plugin deactivates.
   */
  readonly on: (event: string, listener: (data: unknown) => void) => Disposer
} & { readonly [method: string]: (...args: unknown[]) => Promise<unknown> }

export interface ServicesApi {
  /**
   * Offer `impl` (a plain object of functions; no method named `on`, `then`, `constructor` or
   * starting with `_`) as service `name`. Providing the same name again replaces it. Withdrawn
   * when this plugin deactivates.
   */
  provide(name: string, impl: Record<string, (...args: never[]) => unknown>): void
  /** A handle on service `name`; it never throws for a missing provider (calls do). */
  use(name: string): ServiceHandle
  /**
   * Send `event` with plain-data `data` to the consumers of service `name`. Only from the provider
   * the project selected; otherwise dropped (one log line). A function or symbol in `data` throws.
   */
  emit(name: string, event: string, data?: unknown): void
  /**
   * The id of the plugin whose call this plugin is serving: inside one of its provided methods, and
   * in code that method awaits or timers it starts while the call is still running. With nested
   * calls it is the innermost caller (for A -> B -> C, C sees B). `undefined` in `activate`, in
   * event listeners, outside any call, and once the call has returned (a late timer). Set from the
   * caller's own `ctx`, never from arguments; for per-caller usage counts or caps. Not a security
   * boundary: all plugins of a project share one JS realm.
   */
  caller(): string | undefined
  /**
   * Whether a call on service `name` would reach a provider now: `name` is in this plugin's
   * `services.uses`, an enabled plugin provides it at the same major, and with several providers
   * the project picked one. Asked fresh on every call. Never throws: false for anything else,
   * an undeclared or unknown name included. A provider still activating (or whose activate failed)
   * counts; a call then waits for it (or rejects with the failure).
   */
  available(name: string): boolean
  /**
   * The id of the plugin a call on service `name` would reach now (the only provider, or the
   * project's pick among several), or `null` when none would: no enabled provider, several and no
   * pick, or the selected one at another major. Same rule as a call and `available`, asked fresh on
   * every call (call it when you need it, not once in `activate`). For checking who opened an overlay
   * (`OverlayInfo.opener`) against the reviewer the project picked, say. Throws for a name not in
   * this plugin's `services.uses`, and for one in its `services.collects` (the pick does not apply
   * to a collector: `useAll(name).providers()`). An older app has no `provider`: feature-test it.
   */
  provider(name: string): string | null
  /**
   * Every provider of service `name`, for a plugin that reads from all of them (Inbox collecting
   * each `inbox-feed`). `name` must be in both `services.uses` and `services.collects` (app 0.9.7+:
   * older apps refuse a manifest with `collects`). The project's provider pick does not apply, and
   * This Project offers no pick for a name only collectors use. Throws for an undeclared name.
   */
  useAll(name: string): ServiceSet
}

/** One provider of a collected service (`ServiceSet.providers`). */
export interface ServiceProvider {
  /** The providing plugin's id. */
  readonly pluginId: string
  /**
   * A handle whose calls go to this plugin only (they wait while it activates, and reject once it
   * no longer provides the name), and whose `on` hears this plugin's events only.
   */
  readonly handle: ServiceHandle
}

/** `ctx.services.useAll`: the providers of one service, read fresh on every call. */
export interface ServiceSet {
  /**
   * The plugins that provide the name at this plugin's `uses` major and have called `provide`, in
   * the host's plugin order. One still activating joins when it provides (see `onChange`); one
   * whose activate failed, or of another major, is left out.
   */
  providers(): ServiceProvider[]
  /** Events from every provider, with the emitting plugin's id; returns the unsubscriber. */
  on(event: string, listener: (data: unknown, pluginId: string) => void): Disposer
  /**
   * The provider set may have changed (a provider provided, withdrew, reloaded, was enabled or
   * disabled): call `providers()` again. Several changes in one turn call it once.
   */
  onChange(listener: () => void): Disposer
}

/** What a plugin's `main` module exports. */
export interface PluginModule {
  /**
   * Called once per project window, with a 10 s limit. Its return value is ignored; offer an API
   * to other plugins with `ctx.services.provide`. Calling another plugin's service in here waits
   * for that plugin to activate, unless the two call each other (a cycle fails at once).
   */
  activate(ctx: PluginContext): unknown
  /** Called when the window closes or the plugin reloads; the host is killed 5 s later regardless. */
  deactivate?(): unknown
}
