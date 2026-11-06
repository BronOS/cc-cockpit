// The user-facing `ccc` commands as socket handlers (plan: Task 21): open, session note/steps,
// overlay, sessions, notify; the plugin commands (plan B Task 5): plugin.cli.spec, plugin.cli,
// plugin.cli.list; and the plugin dev loop (Task 6): plugin.link, plugin.unlink, plugin.list.
// (`hook` is sessions/hook-handler.ts.)
//
// Authority (CLAUDE.md: main is the only authority): the SocketServer already built `caller` from
// the token or `--project`; nothing in `args` names a tab, window or project main would trust.
//   - note / steps: the tab is `caller.tabId`, a Claude tab's (a session token). The server
//     refuses them without a token and with a window token (a shell or command tab, a terminal
//     overlay), and so does tabOf here.
//   - overlay: the window is the caller's project's window (a session's or window token's, or the
//     open project that `--project` named). A project that is not open is an error, never opened
//     on the side.
//   - everything but note / steps takes a window token like `--project`: the token names the
//     window and grants nothing more.
//   - open: names a folder on purpose (that is its job); main's registry validates it.
//   - sessions / notify: act on no single project. The socket is the user's own, so `sessions`
//     lists every window's tabs (plugins never reach this socket).
//   - plugin.cli*: the caller's project (a tab's, or the one `--project` named). The owning plugin
//     is looked up by name in main's index (the clash rules leave at most one valid owner), and
//     must be enabled in that project; the host manager then checks it runs in the window.
//   - plugin.config: project-scope settings are the caller's project's; `args` names only the
//     plugin, the scope and the values.
// Everything in `args` is untrusted JSON: each field's type is checked here, and text is passed on
// as one value, never through a shell.
//
// No Electron import: main wires the Electron parts in as options, unit tests pass fakes.
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN, type CliContribution } from '../../shared/manifest'
import { encodedBytes, MAX_CLI_IO_BYTES, type PluginCliResult, type PluginCliSpec } from '../../shared/plugin-cli'
import {
  MAX_PLUGIN_CONFIG_EDITS,
  PLUGIN_CONFIG_SCOPES,
  type PluginConfigScope,
  type PluginConfigSetResult,
  type PluginConfigView
} from '../../shared/plugin-config'
import type { HostCliCall } from '../plugins/host-manager'
import { displayText, linkDialogInfo, LinkRequestGate, type LinkCaller, type LinkDialogInfo } from '../plugins/link-request'
import { MAX_HTML_BYTES, type OverlayResult } from '../overlays/overlay-manager'
import type { SessionEntry } from '../sessions/status-reducer'
import type { Caller, Handler } from './socket-server'

/** Longest notification text shown; the CLI argument is otherwise unbounded. */
export const MAX_NOTIFY_CHARS = 1000

/** The slice of a registry the handlers read and write. */
export interface CliSessions {
  addNote(tabId: string, text: string): void
  setSteps(tabId: string, done: unknown, total: unknown): void
  list(): SessionEntry[]
}

export interface CliHandlerOptions {
  /** Open the folder as a project, or focus its window. Throws for a path that is not a folder. */
  openPath(path: string): void
  /** A system notification with this text. */
  notify(text: string): void
  sessions: CliSessions
  /** The display name and folder of a project, for the `sessions` listing. */
  project(projectId: string): { name: string; path: string } | undefined
  /** The project window that is open now. */
  windowIdOf(projectId: string): number | undefined
  /** Open an overlay in a window and wait for how it ended (main's OverlayManager.open). */
  openOverlay(
    windowId: number,
    spec: unknown,
    opener: string,
    peerGone?: AbortSignal
  ): Promise<OverlayResult>
}

/** What `ccc sessions --json` prints one entry of. No token, no queued text, no raw ids but the tab's. */
export interface SessionListing {
  tabId: string
  project: string
  projectPath: string
  cwd: string
  status: string
  tool?: string
  lastPrompt?: string
  sessionId?: string
  notes: string[]
  steps?: { done: number; total: number }
  files: string[]
  queued: number
  exitCode?: number
}

export function openHandler(options: Pick<CliHandlerOptions, 'openPath'>): Handler {
  return (args) => {
    const path = args.path
    if (typeof path !== 'string' || path === '' || path.includes('\0') || !isAbsolute(path)) {
      throw new Error('open needs an absolute folder path')
    }
    options.openPath(path)
    return null
  }
}

/** The Claude tab a session-only command is about; a window token, `--project` or nothing is refused. */
function tabOf(caller: Caller, what: string): string {
  if (caller.kind !== 'session') throw new Error(`${what} needs a Claude session (run it inside a cockpit Claude tab)`)
  return caller.tabId
}

export function noteHandler(options: Pick<CliHandlerOptions, 'sessions'>): Handler {
  return (args, caller) => {
    const tabId = tabOf(caller, 'session note')
    if (typeof args.text !== 'string') throw new Error('session note needs text')
    options.sessions.addNote(tabId, args.text)
    return null
  }
}

export function stepsHandler(options: Pick<CliHandlerOptions, 'sessions'>): Handler {
  return (args, caller) => {
    const tabId = tabOf(caller, 'session steps')
    options.sessions.setSteps(tabId, args.done, args.total)
    return null
  }
}

export function notifyHandler(options: Pick<CliHandlerOptions, 'notify'>): Handler {
  return (args) => {
    if (typeof args.text !== 'string' || args.text.trim() === '') throw new Error('notify needs text')
    const text = args.text.trim()
    options.notify(text.length > MAX_NOTIFY_CHARS ? `${text.slice(0, MAX_NOTIFY_CHARS - 1)}…` : text)
    return null
  }
}

export function sessionsHandler(options: Pick<CliHandlerOptions, 'sessions' | 'project'>): Handler {
  return () =>
    options.sessions.list().map((e): SessionListing => {
      const project = options.project(e.projectId)
      const out: SessionListing = {
        tabId: e.tabId,
        project: project?.name ?? '',
        projectPath: project?.path ?? '',
        cwd: e.cwd,
        status: e.status,
        notes: [...e.notes],
        files: [...e.files],
        queued: e.queue.length
      }
      if (e.tool !== undefined) out.tool = e.tool
      if (e.lastPrompt !== undefined) out.lastPrompt = e.lastPrompt
      if (e.sessionId !== undefined) out.sessionId = e.sessionId
      if (e.steps !== undefined) out.steps = { ...e.steps }
      if (e.exitCode !== undefined) out.exitCode = e.exitCode
      return out
    })
}

/**
 * Read the page for `ccc overlay --html F`. `file` is an absolute path the CLI made from its own
 * cwd. The file is read ONCE, here, and the overlay serves that copy (`cc-overlay://<id>/`, the
 * overlay id being the random one-shot name, see overlay-protocol.ts): nothing about the path
 * reaches the page, no relative resource can be fetched, and editing the file afterwards changes
 * nothing. A regular file of at most MAX_HTML_BYTES; anything else is refused with the reason.
 */
export async function readHtmlFile(file: unknown): Promise<string> {
  if (typeof file !== 'string' || file === '' || file.includes('\0') || !isAbsolute(file)) {
    throw new Error('overlay --html needs an absolute file path')
  }
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    throw new Error('overlay: cannot read that file')
  }
  if (!st.isFile()) throw new Error('overlay: not a regular file')
  if (st.size > MAX_HTML_BYTES) throw new Error('overlay: html is too large')
  try {
    return await readFile(file, 'utf8')
  } catch {
    throw new Error('overlay: cannot read that file')
  }
}

/** The spec for exactly one of `terminal` (argv), `url`, `html` (a file); the manager validates it. */
async function specFrom(args: Record<string, unknown>, defaultCwd: string | undefined): Promise<unknown> {
  const chosen = ['terminal', 'url', 'html'].filter((k) => args[k] !== undefined)
  if (chosen.length !== 1) throw new Error('overlay needs exactly one of terminal, url, html')
  if (args.terminal !== undefined) {
    // The caller's cwd (the CLI sends its own); the project folder when it sent none. The manager
    // checks it is an existing absolute directory.
    const cwd = typeof args.cwd === 'string' ? args.cwd : defaultCwd
    return { kind: 'terminal', argv: args.terminal, cwd }
  }
  if (args.url !== undefined) return { kind: 'url', url: args.url }
  return { kind: 'html', html: await readHtmlFile(args.html) }
}

const NOT_OPEN = 'that project is not open; open it first (ccc open <path>)'

/** A caller that names a project (a token of either kind, or `--project`); `what` names the command in the refusal. */
function knownCaller(caller: Caller, what: string): Exclude<Caller, { kind: 'anonymous' }> {
  if (caller.kind === 'anonymous') throw new Error(`${what} needs a tab token or --project`)
  return caller
}

/** The caller's project, which must have a record (`--project` may name a folder with none). */
function projectOf(caller: Caller, what: string): string {
  const { projectId } = knownCaller(caller, what)
  if (projectId === undefined) throw new Error(NOT_OPEN)
  return projectId
}

/** The caller's project and its window, which must be open now: a command that acts on a window. */
function openProjectOf(
  caller: Caller,
  what: string,
  windowIdOf: (projectId: string) => number | undefined
): { projectId: string; windowId: number } {
  const projectId = projectOf(caller, what)
  const windowId = windowIdOf(projectId)
  if (windowId === undefined) throw new Error(NOT_OPEN)
  return { projectId, windowId }
}

export function overlayHandler(
  options: Pick<CliHandlerOptions, 'project' | 'windowIdOf' | 'openOverlay'>
): Handler {
  return async (args, caller, peerGone) => {
    const { projectId, windowId } = openProjectOf(caller, 'overlay', options.windowIdOf)
    const spec = await specFrom(args, options.project(projectId)?.path)
    return options.openOverlay(windowId, spec, 'cli', peerGone)
  }
}

/** One `contributes.cli` entry of a valid plugin. */
export interface CliOwner {
  pluginId: string
  cli: CliContribution
}

/** What the plugin command handlers need from main (index.ts wires the installer and host manager). */
export interface PluginCliOptions {
  /**
   * The cli commands of every valid plugin, enabled anywhere or not. The installer's clash rules
   * leave at most one owner per name (a loser is not valid), so a name is found at most once.
   */
  cliContributions(): CliOwner[]
  /** Whether the plugin is enabled in the project. */
  enabledIn(projectId: string, pluginId: string): boolean
  /** The project window that is open now. */
  windowIdOf(projectId: string): number | undefined
  /** HostManager.runCli. */
  runCli(projectId: string, pluginId: string, call: HostCliCall, peerGone?: AbortSignal): Promise<PluginCliResult>
}

const PLUGIN_COMMAND = 'a plugin command'

/** The owner of `name` for this project, or the reason the command cannot be used here. */
function ownerFor(options: PluginCliOptions, projectId: string, name: unknown): CliOwner {
  if (typeof name !== 'string' || name === '') throw new Error('plugin command needs a name')
  const owner = options.cliContributions().find((c) => c.cli.name === name)
  if (!owner) throw new Error(`unknown command: ${name}`)
  if (!options.enabledIn(projectId, owner.pluginId)) {
    throw new Error(`${name} comes from plugin ${owner.pluginId}, which is not enabled in this project`)
  }
  return owner
}

/** What the CLI is told about a command (plugin.cli.spec, and each row of plugin.cli.list). */
export function specOf(owner: CliOwner): PluginCliSpec {
  const spec: PluginCliSpec = {
    name: owner.cli.name,
    pluginId: owner.pluginId,
    summary: owner.cli.summary,
    stdin: owner.cli.stdin === true
  }
  if (owner.cli.usage !== undefined) spec.usage = owner.cli.usage
  if (owner.cli.stdin === true && owner.cli.stdinDash === true) spec.stdinDash = true
  return spec
}

/**
 * `plugin.cli.spec { name }`: what the CLI needs before it runs the command (whether to read
 * stdin, the usage for `--help`). Answered from the manifest; the plugin's host is not asked.
 */
export function pluginCliSpecHandler(options: PluginCliOptions): Handler {
  return (args, caller) => specOf(ownerFor(options, projectOf(caller, PLUGIN_COMMAND), args.name))
}

/**
 * `plugin.cli { name, argv, stdin?, cwd }`: run the command in the caller's window. Every field is
 * the caller's and checked here; stdin over the cap is refused (the CLI refuses it first, this is
 * for any other client of the socket). A stdin the command did not declare is dropped.
 */
export function pluginCliHandler(options: PluginCliOptions): Handler {
  return async (args, caller, peerGone) => {
    const projectId = projectOf(caller, PLUGIN_COMMAND)
    // The owner first: "unknown command" says more than a closed window does.
    const owner = ownerFor(options, projectId, args.name)
    if (options.windowIdOf(projectId) === undefined) throw new Error(NOT_OPEN)
    const { argv, stdin, cwd } = args
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) throw new Error('plugin command argv must be strings')
    if (stdin !== undefined && typeof stdin !== 'string') throw new Error('plugin command stdin must be a string')
    if (typeof stdin === 'string' && encodedBytes(stdin) > MAX_CLI_IO_BYTES) {
      throw new Error(`stdin is over ${MAX_CLI_IO_BYTES / 1024} KiB`)
    }
    // argv and stdin travel as one host RPC message: cap argv like stdin so the sum stays well
    // under the socket line limit instead of failing later with a generic error.
    if (encodedBytes(JSON.stringify(argv)) > MAX_CLI_IO_BYTES) {
      throw new Error(`arguments are over ${MAX_CLI_IO_BYTES / 1024} KiB`)
    }
    if (typeof cwd !== 'string' || cwd === '' || cwd.includes('\0') || !isAbsolute(cwd)) {
      throw new Error('plugin command needs an absolute cwd')
    }
    const call: HostCliCall = {
      name: owner.cli.name,
      argv: argv as string[],
      stdin: owner.cli.stdin === true && typeof stdin === 'string' ? stdin : '',
      cwd,
      // Only a Claude tab's session token names a tab (a window token, `--project` and an anonymous
      // caller do not); `args` is never read for it.
      ...(caller.kind === 'session' ? { tabId: caller.tabId } : {})
    }
    return options.runCli(projectId, owner.pluginId, call, peerGone)
  }
}

/** `plugin.cli.list {}`: the plugin commands of the caller's project, for `ccc help` (tab only). */
export function pluginCliListHandler(options: PluginCliOptions): Handler {
  return (_args, caller) => {
    const projectId = projectOf(caller, PLUGIN_COMMAND)
    return options
      .cliContributions()
      .filter((c) => options.enabledIn(projectId, c.pluginId))
      .map(specOf)
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

export function registerPluginCliHandlers(server: { handle(cmd: string, handler: Handler): void }, options: PluginCliOptions): void {
  server.handle('plugin.cli.spec', pluginCliSpecHandler(options))
  server.handle('plugin.cli', pluginCliHandler(options))
  server.handle('plugin.cli.list', pluginCliListHandler(options))
}

/** One row of `ccc plugin list`. */
export interface PluginListing {
  id: string
  name?: string
  version: string
  source: 'git' | 'linked' | 'bundled'
  /** Enabled in the caller's project. */
  enabled: boolean
  /** `ok`, or the reason the plugin is not usable. */
  state: string
}

/** What the plugin dev loop handlers (plan B Task 6) need from main. */
export interface PluginDevOptions {
  /** The project window that is open now. */
  windowIdOf(projectId: string): number | undefined
  /** PluginInstaller.inspectLink: what linking the folder would link (throws what link throws). */
  inspectLink(path: string): Promise<{ id: string; name: string; version: string; dir: string; alreadyLinked: boolean }>
  /**
   * Ask the person, in that window. Resolves true only for Allow. `signal` aborts when the caller
   * of `ccc` went away (the dialog should close).
   */
  confirmLink(windowId: number, info: LinkDialogInfo, signal?: AbortSignal): Promise<boolean>
  /**
   * Link the folder and enable the plugin in the project. Whether the folder is linked already is
   * decided again here, at Allow time: `alreadyLinked` from inspectLink is from before the dialog,
   * and the folder may have been linked (Settings, another window) or unlinked while it was open.
   */
  linkAndEnable(projectId: string, info: { id: string; dir: string }): Promise<void>
  /** Remove a linked plugin; throws for one that is not linked. */
  unlink(id: string): Promise<void>
  list(projectId: string): PluginListing[]
}

/**
 * `plugin.link { path }`: link a plugin folder and enable it in the caller's project, after a
 * native confirm in the caller's window. The CLI waits for the person with no timeout.
 *
 * Order matters: count the request against the window's inspection rate, validate (a folder that
 * cannot be linked never shows a dialog), then claim
 * the window's dialog slot (one pending, a few a minute), then ask. Allow links through the
 * installer with the id the person saw as `expectedId`, so a manifest whose id changed while the dialog
 * was open does not link some other plugin (the rest of the manifest is not re-checked; a linked
 * folder is live-reloaded anyway). Deny, a closed window or a vanished caller are "declined".
 */
export function pluginLinkHandler(options: PluginDevOptions, gate: LinkRequestGate): Handler {
  return async (args, caller, peerGone) => {
    const { projectId, windowId } = openProjectOf(caller, 'plugin link', options.windowIdOf)
    const path = args.path
    if (typeof path !== 'string' || path === '' || path.includes('\0') || !isAbsolute(path)) {
      throw new Error('plugin link needs an absolute folder path')
    }
    // Counted before the manifest is read: that read (and the skill walk) is the cost to bound.
    gate.inspect(windowId)
    const info = await options.inspectLink(path)
    const release = gate.begin(windowId)
    let allowed: boolean
    try {
      // openProjectOf took a token or a `--project` caller only (an anonymous one has no project).
      allowed = await options.confirmLink(windowId, linkDialogInfo(info, linkCallerOf(caller)), peerGone)
    } finally {
      release()
    }
    if (!allowed || peerGone?.aborted) throw new Error('declined: the plugin was not linked')
    await options.linkAndEnable(projectId, { id: info.id, dir: info.dir })
    return { id: info.id, name: displayText(info.name) }
  }
}

/**
 * Who the link dialog says asked. Either token kind is "a tab of this window" (a Claude tab, a
 * shell or command tab, or a terminal overlay shown over the window); only `--project` came from
 * outside the app. A switch, so a new Caller kind has to be placed here.
 */
function linkCallerOf(caller: Caller): LinkCaller {
  switch (caller.kind) {
    case 'session':
    case 'window':
      return 'tab'
    case 'project':
    case 'anonymous':
      return 'project'
  }
}

/** `plugin.unlink { id }`: remove a linked plugin (a git install is managed in Settings). */
export function pluginUnlinkHandler(options: PluginDevOptions): Handler {
  return async (args, caller) => {
    // Any known caller: unlinking is not about one project (the plugin goes for every one), so a
    // `--project` folder with no record is fine here.
    knownCaller(caller, 'plugin unlink')
    const id = args.id
    if (typeof id !== 'string' || id === '') throw new Error('plugin unlink needs a plugin id')
    await options.unlink(id)
    return null
  }
}

/** `plugin.list {}`: the installed plugins and whether each is enabled in the caller's project. */
export function pluginListHandler(options: PluginDevOptions): Handler {
  return (_args, caller) => {
    return options.list(projectOf(caller, 'plugin list'))
  }
}

export function registerPluginDevHandlers(
  server: { handle(cmd: string, handler: Handler): void },
  options: PluginDevOptions,
  gate: LinkRequestGate = new LinkRequestGate()
): void {
  server.handle('plugin.link', pluginLinkHandler(options, gate))
  server.handle('plugin.unlink', pluginUnlinkHandler(options))
  server.handle('plugin.list', pluginListHandler(options))
}

/** What `plugin.config` needs from main (index.ts binds main/settings/plugin-config.ts to the settings services). */
export interface PluginConfigOptions {
  view(projectId: string, pluginId: string): PluginConfigView
  set(projectId: string, pluginId: string, edits: Array<[string, unknown]>, scope?: PluginConfigScope): Promise<PluginConfigSetResult>
  /** Drop the project's overrides of these project fields (`--use-global`). */
  useGlobal(projectId: string, pluginId: string, keys: string[]): Promise<PluginConfigSetResult>
}

/**
 * `plugin.config { id, scope?, set?, useGlobal? }` (friction round 1, Task 6; design-next §5.2): print
 * a plugin's app, global and project settings, set top-level fields through the Settings form's
 * save, or drop project overrides (`useGlobal`, alone: no `set`, no `scope`). The project is the caller's
 * (a token's, or the one `--project` named), never a field of `args`; it needs a record, like
 * `plugin list`, but no open window (the record is saved, a host that is not running has nothing
 * to tell). Every field is checked here; values are any JSON, the schema decides in main.
 */
export function pluginConfigHandler(options: PluginConfigOptions): Handler {
  return async (args, caller) => {
    const projectId = projectOf(caller, 'plugin config')
    const { id, scope, set, useGlobal } = args
    if (typeof id !== 'string' || id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id)) {
      throw new Error('plugin config needs a plugin id')
    }
    if (scope !== undefined && !PLUGIN_CONFIG_SCOPES.includes(scope as PluginConfigScope)) {
      throw new Error('plugin config: scope is app, global or project')
    }
    if (useGlobal !== undefined) {
      if (set !== undefined || scope !== undefined) throw new Error('plugin config: use-global goes alone, without values to set or a scope')
      if (!Array.isArray(useGlobal) || useGlobal.length === 0 || useGlobal.length > MAX_PLUGIN_CONFIG_EDITS) {
        throw new Error(`plugin config: use-global takes 1 to ${MAX_PLUGIN_CONFIG_EDITS} keys`)
      }
      const keys: string[] = []
      for (const key of useGlobal as unknown[]) {
        if (typeof key !== 'string' || key === '') throw new Error('plugin config: each use-global key is a non-empty string')
        keys.push(key)
      }
      return options.useGlobal(projectId, id, keys)
    }
    if (set === undefined) {
      if (scope !== undefined) throw new Error('plugin config: scope goes with values to set')
      return options.view(projectId, id)
    }
    if (!Array.isArray(set) || set.length === 0 || set.length > MAX_PLUGIN_CONFIG_EDITS) {
      throw new Error(`plugin config: set takes 1 to ${MAX_PLUGIN_CONFIG_EDITS} key=value pairs`)
    }
    const edits: Array<[string, unknown]> = []
    for (const pair of set as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0] === '') {
        throw new Error('plugin config: each edit is a [key, value] pair with a non-empty key')
      }
      edits.push([pair[0], pair[1] as unknown])
    }
    return options.set(projectId, id, edits, scope as PluginConfigScope | undefined)
  }
}

export function registerPluginConfigHandler(server: { handle(cmd: string, handler: Handler): void }, options: PluginConfigOptions): void {
  server.handle('plugin.config', pluginConfigHandler(options))
}

/** What `panel.show` needs from main (index.ts binds the plugin list, the project record and the layout service). */
export interface PanelShowOptions {
  /** Whether the plugin is installed and valid. */
  pluginKnown(pluginId: string): boolean
  /** Whether the plugin is enabled in the project. */
  enabledIn(projectId: string, pluginId: string): boolean
  /** The project window that is open now. */
  windowIdOf(projectId: string): number | undefined
  /** LayoutService.show, the call behind ctx.panels.show: false for a panel the project does not have. */
  showPanel(projectId: string, panelKey: string): boolean
}

/**
 * `panel.show { plugin, panel }` (friction round 1, Task 7): reveal a panel in the caller's project
 * window, as `ctx.panels.show` does for the plugin itself. The project is the caller's (a token's,
 * or the one `--project` named), never a field of `args`. Refuses, in this order, an unknown
 * plugin, a plugin not enabled in the project, a project with no open window, and a panel the
 * project does not have (undeclared, or its plugin's host not reporting it).
 */
export function panelShowHandler(options: PanelShowOptions): Handler {
  return (args, caller) => {
    const projectId = projectOf(caller, 'panel show')
    const { plugin, panel } = args
    if (typeof plugin !== 'string' || plugin.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(plugin)) {
      throw new Error('panel show needs a plugin id')
    }
    if (typeof panel !== 'string' || panel === '' || panel.length > 200 || panel.includes('/')) {
      throw new Error('panel show needs a panel id')
    }
    if (!options.pluginKnown(plugin)) throw new Error(`unknown plugin: ${plugin}`)
    if (!options.enabledIn(projectId, plugin)) throw new Error(`plugin ${plugin} is not enabled in this project`)
    if (options.windowIdOf(projectId) === undefined) throw new Error(NOT_OPEN)
    if (!options.showPanel(projectId, `${plugin}/${panel}`)) throw new Error(`plugin ${plugin} has no panel "${panel}" in this project`)
    return null
  }
}

export function registerPanelShowHandler(server: { handle(cmd: string, handler: Handler): void }, options: PanelShowOptions): void {
  server.handle('panel.show', panelShowHandler(options))
}

/** Register every user command on the server (a `handle(cmd, handler)` is all it needs). */
export function registerCliHandlers(
  server: { handle(cmd: string, handler: Handler): void },
  options: CliHandlerOptions
): void {
  server.handle('open', openHandler(options))
  server.handle('session.note', noteHandler(options))
  server.handle('session.steps', stepsHandler(options))
  server.handle('overlay', overlayHandler(options))
  server.handle('sessions', sessionsHandler(options))
  server.handle('notify', notifyHandler(options))
}
