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
// (src/sdk/panel.ts, loaded as `/__sdk/panel.js`).

export const PLUGIN_API_VERSION = 1

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Undo a registration (a listener, a schedule, a command). Calling it twice is harmless. */
export type Disposer = () => void

/** The plugin's settings, validated against the manifest's JSON Schemas with defaults applied. */
export interface PluginSettings {
  /** This project's values (`contributes.settings.project`). */
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
 * How big an overlay is drawn: `default` a centered dialog (75 % of the window), `large` about 90 %,
 * `full` the whole window below the top bar with a small margin. Every size keeps the title bar and
 * the close button. A terminal overlay's program is resized to fit.
 */
export type OverlaySize = 'default' | 'large' | 'full'

export type OverlaySpec =
  | { kind: 'terminal'; argv: string[]; cwd?: string; title?: string; size?: OverlaySize }
  | { kind: 'url'; url: string; title?: string; size?: OverlaySize }
  /**
   * One of the plugin's own pages (plugin-relative path), loaded like a panel: the plugin's CSP,
   * the app theme and the panel SDK. The page answers with `ccPanel.post({ result: value })`,
   * which closes the overlay and resolves `open` with `{ kind: 'value', value }`. With
   * `overlay.start`, anything else it posts (no `result` key) goes to the handle's `onMessage`.
   */
  | { kind: 'html'; file: string; title?: string; size?: OverlaySize }

export type OverlayResult =
  | { kind: 'exit'; code: number }
  | { kind: 'value'; value: JsonValue }
  | { kind: 'dismissed' }

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
}

export type SessionStatus = 'starting' | 'idle' | 'working' | 'needs-permission' | 'waiting' | 'ended'

/** One Claude tab of this project window. */
export interface SessionInfo {
  readonly tabId: string
  readonly status: SessionStatus
  readonly cwd: string
  readonly sessionId?: string
  readonly tool?: string
  readonly lastPrompt?: string
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
    /** JSON only, at most 1 MiB. Dropped while the panel is not shown (it asks again when it connects). */
    post(panelId: string, message: JsonValue): void
    onMessage(panelId: string, listener: (message: JsonValue) => void): Disposer
    /**
     * Bring one of this plugin's own panels (either kind, a `webview` one included) into sight: a
     * hidden panel comes back, a closed one opens, its zone expands. Throws for an undeclared id;
     * a refusal from main is logged.
     */
    show(panelId: string): void
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
  }

  // sessions
  readonly sessions: {
    list(): Promise<SessionInfo[]>
    /** The whole list again whenever one of this window's Claude tabs changes (at most 4 per second). */
    onChange(listener: (sessions: SessionInfo[]) => void): Disposer
    /**
     * Typed only while the tab is waiting for input; queued otherwise (delivered at a later Stop).
     * Rejects for a tab of another window, text starting with "/", "!", "#" or "&", and over 30 texts a minute.
     */
    send(tabId: string, text: string): Promise<SendResult>
    /**
     * A new Claude tab in this window; `cwd` must resolve inside the project folder, `prompt` is
     * passed as an argument, never typed (and may not start with "/", "!", "#" or "&"). At most 5 a minute.
     */
    open(options: { cwd?: string; prompt?: string }): Promise<{ tabId: string }>
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
  }

  /**
   * Services between the plugins of one project (manifest `services`). Names must be declared:
   * `provide` only names in `services.provides`, `use` only names in `services.uses`.
   */
  readonly services: ServicesApi

  // misc
  /** Lines go to `<data>/logs/<pluginId>.log` (rotated at 5 MiB). */
  readonly log: PluginLogger
  /**
   * A system notification; text is cut at 500 characters, at most 10 per minute per plugin and
   * window (more reject).
   */
  notify(text: string): Promise<void>
}

/**
 * A consumer's view of a service (`ctx.services.use`). Every property but `on` is an async method
 * of the provider: `await handle.search(q)`. The provider is resolved on each call, so the handle
 * keeps working across provider reloads and restarts. Arguments and results are copied as plain
 * data (structured clone): a function or symbol in them fails the call, a class instance arrives as
 * a plain object. A call waits for a still-activating provider; it rejects when no enabled plugin
 * provides the service, two do and none is picked in Settings > Plugins, the major versions differ,
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
