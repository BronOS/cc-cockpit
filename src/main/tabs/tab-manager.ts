// Tabs of every project window: which PTY belongs to which tab, in which order, with which
// token. main is the only authority (CLAUDE.md): every method takes the project id main resolved
// from the IPC sender, and a tab id that belongs to another project is simply unknown here, so a
// renderer cannot reach another window's terminal by guessing or replaying an id.
//
// No Electron import: PTYs come in through a PtyBackend and renderer events go out through
// `emit`, so vitest drives all of this with fakes.
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { errorText } from '../../shared/error-text'
import type { EventChannel, IpcEventMap, TabInfo } from '../../shared/ipc'
import type { ScreenAnswer } from '../../shared/terminal-screen'
import { checkSessionName } from '../../shared/session-name'
import { applyFlagPatch, checkFlagPatch, DEFAULT_FLAG_COLOR, sameFlag, tabFlagOf, type FlagColor, type TabFlag } from '../../shared/tab-flag'
import { sameTabRoom, tabRoomOf, type TabRoom } from '../../shared/tab-room'
import { PLUGIN_ID_MAX_LENGTH, PLUGIN_ID_PATTERN } from '../../shared/manifest'
import { checkPageTabSpec, MAX_PAGE_TABS_PER_PLUGIN, pageTabIconOf, pageTabTitleOf, type PageTabSpec } from '../../shared/page-tabs'
import { checkCommandArgv, checkTabCommandLabel, checkTabCommandLine } from '../../shared/tab-commands'
import type { TabKind } from '../../shared/types'
import type { Env } from '../env/login-env'
import { buildPtyEnv } from '../env/pty-env'
import { exitStatus, type PtyBackend } from '../pty/pty-backend'
import { PtyService, validSize } from '../pty/pty-service'
import { isPersonInput, stripQueryReplies } from '../sessions/terminal-reports'
import { DesktopFlow, VIEW_LOW_WATER } from '../terminals/desktop-flow'
import type { MirrorView } from '../terminals/mirror'
import type { TokenOwner } from '../socket/socket-server'
import { isRemoteViewId, type ViewId } from '../../shared/views'
import { RECONNECT_GRACE_MS, TerminalSizes } from './terminal-sizes'
import { claudeArgv, commandArgv, loginShellOf, shellArgv } from './claude-argv'
import { warnLog } from '../warn-log'

/**
 * A new PTY starts at this size; the renderer sends the real one (`tabs.resize`) as soon as
 * xterm has measured its container, which it can only do after the tab exists. A restart spawns at
 * the size the tab had (its sizing view's, terminal-sizes.ts), so a view's screen is not reflowed
 * to 80 x 24 and back.
 */
const INITIAL_COLS = 80
const INITIAL_ROWS = 24

/**
 * Server mode's start size (design-web.md §9.8): the hidden page never measures a tab, so a tab no
 * browser has sized (a new one, or restarted overnight with none attached) has nothing to wait for.
 * 80 x 24 would wrap Claude's first screen narrow for the browser that attaches later and reflow it
 * on its first fit; 120 x 40 is a laptop-ish pane.
 */
export const SERVER_INITIAL_COLS = 120
export const SERVER_INITIAL_ROWS = 40

/**
 * The view a size or a key is from when the caller names none: the desktop window (tests, and
 * main's own callers). The router passes the CallView's id, `desktop:<windowId>` or `web:<n>`.
 */
const DESKTOP_VIEW: ViewId = 'desktop'

/**
 * A shell tab that ends sooner than this after its spawn keeps its banner even under
 * `close-clean`. A shell's exit code is the status of the user's LAST command (zsh leaves `$?` = 1
 * at the first prompt when the rc files end on a failing command), so for a terminal the code says
 * nothing about a normal end and the tab closes on any exit. What would vanish silently with that
 * rule is a shell that never came up (a broken $SHELL, an rc file that runs `exit`): it dies
 * within moments of the spawn, while no user types `exit` that fast. 1 s clears a slow rc file's
 * crash and stays below a human's fastest Ctrl+D. Measured per process generation (Tab.spawnedAt),
 * so a Restart starts the clock again.
 */
export const SHELL_MIN_LIFE_MS = 1000

/** A tab token: 32 random bytes as lowercase hex (see start()). */
const TOKEN_RE = /^[0-9a-f]{64}$/

export interface TabManagerOptions {
  backend: PtyBackend
  /** The real folder path of a project id, or undefined when the id is not a known project. */
  projectPath(projectId: string): string | undefined
  /** Login-shell env (see login-env.ts); read at each spawn so a late capture is picked up. */
  loginEnv(): Env
  /** `<data>/hooks.json`, handed to `claude --settings`. */
  hooksPath: string
  /**
   * The `--plugin-dir` folders for a Claude tab of this project (ClaudePlugins.pluginDirsFor),
   * read synchronously at each spawn: a new tab, a restart and a restore all pick up the current
   * set, while a running session keeps what it started with (Claude loads plugins at launch).
   * Absent = none.
   */
  pluginDirsFor?(projectId: string): string[]
  /** `<data>/bin`, put first on PATH so `ccc` resolves inside a tab. */
  binDir: string
  /**
   * The CLI socket path exported to every tab as CC_COCKPIT_SOCK, read at each spawn; undefined
   * while main is not listening on it (see pty-env.ts TabEnvVars.sock).
   */
  sock(): string | undefined
  /** Send an event to the window that owns `projectId` (a closed window drops it). */
  emit<C extends EventChannel>(projectId: string, channel: C, payload: IpcEventMap[C]): void
  /**
   * The same, to that window's desktop view only (not its browsers); false when none took it.
   * Through the same sink as `emit`, so it reaches the page in order with the `tabs.data` before it
   * (TerminalFlow.askScreen relies on that). Absent: nothing is ever asked of the desktop.
   */
  emitDesktop?<C extends EventChannel>(projectId: string, channel: C, payload: IpcEventMap[C]): boolean
  /** Told when a tab's process starts, exits or the tab is forgotten (the session registry). */
  lifecycle?: TabLifecycle
  /**
   * The persisted shape of a project's tabs changed: a tab was created, closed, moved, restarted,
   * got a resumable Claude session id or dropped one (a fresh process replaced it after a failed
   * resume, or `/clear` replaced it; restore.ts saves them). Not called for `restoreTab` (the
   * restorer saves once after the whole batch) nor for a window closing (its tabs die with it;
   * whether to keep them is main's call).
   */
  onTabsChanged?(projectId: string): void
  /**
   * Read at each exit: true closes a tab whose process ended normally as if the user had clicked
   * Close (what "normally" means depends on the tab kind, see closesOnExit); false (or absent) keeps it with its exited banner. main answers
   * from the app setting `tabExit` and false while quitting (index.ts). See onExit for the exits
   * that never close a tab whatever this says.
   */
  closeOnCleanExit?(): boolean
  /**
   * The room registry's side of a member tab (design-rooms.md §1; RoomService wires it to
   * RoomRegistry). Absent = no registry to ask (tests): a restored membership is kept as saved.
   */
  rooms?: TabRoomHooks
  /** Clock for a shell tab's minimum life (SHELL_MIN_LIFE_MS); tests inject one. Default Date.now. */
  now?: () => number
  /** Overrides TAKE_DEBOUNCE_MS (terminal-sizes.ts) for tests. */
  sizeDebounceMs?: number
  /**
   * Server mode (design-web.md §9.8): the desktop view is the hidden page, never a measured view, so
   * only browsers size a pty; a tab nobody sized starts at SERVER_INITIAL_COLS x ROWS, and the page
   * follows the pty's size like a browser that does not size it.
   */
  server?: boolean
  /**
   * The name of the device behind a view, for TabInfo.typedBy: a browser's device name (the
   * requester's own text, web/devices.ts), the desktop's. Default: "Desktop" or "a browser".
   */
  deviceOf?: (viewId: ViewId) => string
  /**
   * Which views are one screen across a reconnect (a browser view's signed-in device id; undefined
   * for the desktop's and None's anonymous browsers): a tab whose size fell from a view that left
   * goes back to the next view of its lineage (views/view-sizes.ts `departed`).
   */
  lineageOf?: (viewId: ViewId) => string | undefined
  /** Overrides RECONNECT_GRACE_MS (views/view-sizes.ts) for tests. */
  reconnectGraceMs?: number
  /** Overrides SHELL_MIN_LIFE_MS; main sets it only under CC_COCKPIT_TEST so e2e can exit fast. */
  shellMinLifeMs?: number
  log?: (message: string) => void
  /**
   * The headless terminals of web access (terminals/mirror.ts, design-web.md §5.2). Called
   * synchronously at the marked tap points; the mirror itself returns at once while web access is
   * off. Absent in tests that do not need it.
   */
  terminalTap?: TerminalTap
  /**
   * The tab the project's window shows now, any kind (SessionRegistry.selectedTab, the selection of
   * the view that acted last): a page tab opened while one is selected starts with the unseen dot
   * (TabInfo.unseen). Absent (tests that do not care): no tab is ever unseen.
   */
  selectedTab?(projectId: string): string | undefined
}

/**
 * What a headless copy of a tab's terminal needs, told synchronously and in stream order: the
 * pty's spawn size (a new tab and a restart), the SAME flushed chunks the renderer gets in
 * `tabs.data` (same strings, same order), every size the pty took, and the tab going away.
 * A throwing tap is logged like a lifecycle listener and never undoes the tab operation.
 *
 * The optional members make the tap the ptys' flow consumer (design-web.md §5.2, mirror.ts): it
 * gets a TerminalFlow at TabManager's construction, and the desktop resyncs a tab through `join`
 * when it falls behind (terminals/desktop-flow.ts).
 */
export interface TerminalTap {
  spawned(tabId: string, cols: number, rows: number): void
  data(tabId: string, chunk: string): void
  resized(tabId: string, cols: number, rows: number): void
  closed(tabId: string): void
  bindFlow?(flow: TerminalFlow): void
  /** A snapshot of the tab, then every item after it (mirror.ts `join`); undefined when not held. */
  join?(tabId: string, view: MirrorView): (() => void) | undefined
  /** The newest item numbered for the tab. */
  seq?(tabId: string): number | undefined
  /**
   * Whether the tap answers the tab's terminal queries (mirror.ts `answers`, design-web.md §5.2):
   * then the views' own replies are stripped from their input (`viewInput`).
   */
  answers?(tabId: string): boolean
  /**
   * The desktop page's answer to an `askScreen` (mirror.ts `screen`), for a tab of the sender's
   * project (TabManager.screen checked): untrusted data the tap checks against its own ask.
   */
  screen?(tabId: string, answer: ScreenAnswer): void
}

/**
 * TabManager's flow control as the tap drives it. While the tap `take`s a tab, its pty is acked by
 * the tap (`ack`, characters it consumed), never by the renderer, and the desktop's output for it
 * is flow-controlled on its own (DesktopFlow). `release` hands it back to the renderer's acks.
 */
export interface TerminalFlow {
  /** Deferred while the desktop owes more than VIEW_LOW_WATER of the tab's output (TabManager `pendingTake`). */
  take(tabId: string): void
  ack(tabId: string, count: number): void
  release(tabId: string): void
  /**
   * The tabs with a running pty and the size each has now: what the mirror starts from when web
   * access is turned on while they run (mirror.ts `start`, their baseline).
   */
  running?(): Array<{ tabId: string; cols: number; rows: number }>
  /** Whether the desktop was sent all of the tab's output (DesktopFlow.settled): safe to release. */
  settled?(tabId: string): boolean
  /**
   * The tap's answer to a terminal query of the tab's program (mirror.ts, Task 14): written to the
   * pty as it is, like a terminal's own reply. Not input: it never reaches `typed` or the send gate.
   */
  reply?(tabId: string, data: string): void
  /**
   * Ask the tab's desktop page for its screen (`tabs.screenAsk`, mirror.ts "Seeding"), answered
   * with `tabs.screen` (TabManager.screen). Sent at once, after every `tabs.data` sent before this
   * call: the page answers as of exactly that output. False when no desktop view took the ask.
   */
  askScreen?(tabId: string, ask: { id: number; scrollback: number }): boolean
}

/**
 * What a member tab's comings and goings mean to the room registry (design-rooms.md §1 "Restart"):
 * only the person's close (or a plugin's, or a clean exit closing the tab: the tab is gone for good,
 * never restored) ends a membership; a tab that goes with its window or the app stays a member with
 * no tab until a restore binds its saved membership again. Called synchronously; one that throws is
 * logged and does not undo the tab operation.
 */
export interface TabRoomHooks {
  /**
   * A restored tab's saved membership, under the tab's new id, before its process starts: the
   * member's current coordinator flag when the room still has that member free (RoomRegistry.rebind
   * then memberOf), undefined when not (the room ended or was deleted, the member was removed):
   * the tab then comes back in no room.
   */
  rebind(tabId: string, room: { id: string; name: string }): { coordinator: boolean } | undefined
  /** A member tab was closed for good (TabManager.close, a clean exit closing it): its membership ends. */
  closed(tabId: string, room: TabRoom): void
  /** A member tab went with its window or the app: the member stays, unbound (RoomRegistry.unbind). */
  gone(tabId: string): void
}

/**
 * Tab lifecycle as other main modules see it. Plain callbacks, called synchronously; one that
 * throws is logged and does not undo the tab operation that triggered it.
 */
export interface TabLifecycle {
  /** After a successful spawn: a new tab or a restart (the tab keeps its id on restart). */
  started?(tab: TabEvent): void
  /**
   * The process exited. The tab is still open (it can be restarted), unless a clean exit closes
   * it, in which case `closed` follows at once (TabManagerOptions.closeOnCleanExit).
   */
  exited?(tabId: string, code: number, signal: number | null): void
  /** The tab no longer exists: closed by the user or its window closed. */
  closed?(tabId: string): void
  /** The person (or a plugin) named the tab, or cleared the name (`null`). */
  renamed?(tabId: string, name: string | null): void
  /** The person flagged the tab, changed its flag or cleared it (`null`). Only ever the person (setFlag). */
  flagged?(tabId: string, flag: TabFlag | null): void
  /**
   * The tab's room membership or the person's mark changed (`null`: in no room any more). Not called
   * for a membership a restore brought back (`started` carries it, TabEvent.room) nor for the tab's
   * close (`closed` says it).
   */
  roomChanged?(tabId: string, room: TabRoom | null): void
  /**
   * A Claude tab's PTY printed `chunk` (each batch PtyService flushes, so a few per frame at most).
   * For the terminal title (session-registry.ts tabOutput); shell and command tabs are not reported.
   */
  output?(tabId: string, chunk: string): void
}

export interface CreateTabOptions {
  /** A command tab is opened with createCommand, never here. */
  kind: 'claude' | 'shell'
  /** Folder or subfolder of the project; relative paths resolve against the project folder. */
  cwd?: string
  /** Initial prompt for a Claude tab, passed as an argv argument and never typed. */
  prompt?: string
  /** `--model` / `--effort` of a new Claude tab (shared/session-options.ts); never on a restart or restore. */
  model?: string
  effort?: string
}

/** A command tab's own copy of its new-tab menu entry (TabCommandsService.resolve). */
export interface TabCommand {
  label: string
  command: string
}

/**
 * A command tab a plugin opened (ctx.sessions.openCommand): `argv` is spawned as is, with no shell
 * in between, so a word the plugin put in (a file name from the repo) stays one argument whatever
 * it contains. `openedBy` / `openedByName` are what the tab shows ("Opened by Files
 * (cockpit.files)"): the one safeguard of a plugin command tab is that the person can see whose it
 * is (design.md §3 "Custom commands"). Display only, never an authority: nothing is allowed or
 * refused by them, except that restore drops the tab once that plugin is gone (restore.ts).
 */
export interface PluginTabCommand {
  label: string
  argv: string[]
  openedBy: string
  /** The plugin's manifest name when it was opened; absent = show the bare id. */
  openedByName?: string
}

/** Either kind of command a command tab runs. */
export type AnyTabCommand = TabCommand | PluginTabCommand

export function isPluginCommand(command: AnyTabCommand): command is PluginTabCommand {
  return 'argv' in command
}

/** What createPluginCommand takes (host-api checked it all already; checked again here). */
export interface PluginCommandOptions {
  argv: string[]
  /** Folder or subfolder of the project, like CreateTabOptions.cwd; absent = the project folder. */
  cwd?: string
  /** The tab's title. */
  title: string
  openedBy: string
  openedByName?: string
}

/** What the lifecycle's `started` hears about a tab (the session registry builds its entry from it). */
export interface TabEvent {
  tabId: string
  projectId: string
  kind: TabKind
  cwd: string
  name?: string
  flag?: TabFlag
  /** The room membership the tab starts with (a restored member the registry rebound), mark included. */
  room?: TabRoom
  /**
   * The tab is the person's from its start: a restored room member (design-rooms.md §1 "Restart":
   * `typed` is not saved, and the restored session is the person's), so the session registry's
   * entry is born typed and its room's messages wait for the person's mark.
   */
  typed?: true
}

/** A tab to bring back at start (restore.ts builds these from the saved records). */
export interface RestoreTabOptions {
  kind: TabKind
  /** Already checked against the project folder by the restore plan; re-checked here anyway. */
  cwd?: string
  /** A Claude tab resumes this session (`--resume <id>`); absent = a fresh `claude`. */
  resumeId?: string
  /**
   * A command tab's saved copy of its entry, or of the argv a plugin opened it with; required for,
   * and only for, kind 'command'.
   */
  command?: AnyTabCommand
  /** A Claude tab's saved name (restore.ts validated it; re-checked here). */
  name?: string
  /** The tab's saved flag, any kind (restore.ts read it leniently; re-read here). */
  flag?: TabFlag
  /**
   * A Claude tab's saved room membership (restore.ts read it leniently; re-read here), kept only
   * when the room registry still has that member (TabRoomHooks.rebind). Ignored on any other kind.
   */
  room?: TabRoom
  /** Required for, and only for, kind 'page': its plugin, type, params, title, icon (re-checked here). */
  page?: PageTabSpec
}

interface Tab {
  id: string
  projectId: string
  kind: TabKind
  cwd: string
  /**
   * Which process of the tab is current: 1 for the first, +1 per Restart (TabInfo.gen). 0 = none
   * ever ran: a restored command tab waiting for the user's Restart (TabInfo.notStarted).
   */
  gen: number
  /** `now()` at the spawn of the current process; a shell tab's minimum life counts from it. */
  spawnedAt: number
  /** Kind 'command' only: the entry (or plugin argv) copied when the tab was opened; every (re)start runs this. */
  command?: AnyTabCommand
  /** Kind 'claude' only: the name the person gave the tab (rename); saved and restored with it. */
  name?: string
  /** Any kind: the person's flag (setFlag / toggleFlag); saved and restored with the tab. */
  flag?: TabFlag
  /**
   * Kind 'claude' only: the tab's room membership (setRoom / clearRoom, the room service) and the
   * person's mark on it (setRoomMark); saved and restored with the tab.
   */
  room?: TabRoom
  /** A restored room member: the session registry's entry is born typed (TabEvent.typed). Never saved. */
  restoredMember?: true
  /** Any kind: the view the person last typed in (TabInfo.typedBy); not saved, the views are gone after a restart. */
  typedBy?: { viewId: ViewId; device: string }
  /**
   * This tab's socket token, regenerated on every (re)start and gone with the tab. A Claude tab's
   * is a session token (hooks, `session note`, everything); a shell or command tab's is a window
   * token (resolveToken says which, from `kind`).
   */
  token: string
  /** The Claude session the running (or last) process reported through SessionStart. */
  sessionId?: string
  /**
   * `sessionId` names a conversation `claude --resume` will find. Claude refuses an id that has
   * no stored conversation ("No conversation found"), and a session nobody typed into may have
   * none, so a tab opened and quit untouched would come back as a dead tab on every launch, and
   * Restart would reuse the dead id forever. True once a UserPromptSubmit arrived for this id, or
   * when the id came from a resume (restore, restart): that conversation had a prompt already.
   */
  resumable: boolean
  /**
   * The current process was started with `--resume` and has not reported a SessionStart yet.
   * The first SessionStart of such a process names the resumed conversation (whatever id Claude
   * gives it), so it stays resumable. A later one with a new id is resumable only when its
   * `source` says it continues a stored conversation (interactive `/resume`, a fork); `/clear`
   * starts an empty session (see sessionStarted).
   */
  resuming: boolean
  /**
   * A `--resume` process of this tab died before its SessionStart, so Restart starts a fresh
   * `claude` instead of failing on the same id again. The id itself stays saved (sessionId and
   * resumable untouched) until a replacement process reports a SessionStart: the same early death
   * comes from a `claude` that could not start at all (a Finder launch whose login-env capture
   * failed has no `claude` on PATH, node-pty then exits 1) or from hooks that cannot report, not
   * only from Claude refusing the id, and dropping the id there would cut every restored tab off
   * its conversation for good. Cleared by the next SessionStart.
   */
  resumeFailed: boolean
  exit?: { code: number; signal: number | null }
  /** Kind 'page' only: what it shows (checkPageTabSpec). Such a tab never has a pty, token or exit. */
  page?: PageTabSpec
  /** The core unseen dot (TabInfo.unseen): opened while another tab was selected, not shown since. */
  unseen?: true
  /**
   * Kind 'page' only: the views whose page of this tab says it holds unsaved changes
   * (design-editor.md §1 "Dirty and close"). TabInfo.dirty while not empty; never saved.
   */
  dirtyIn?: Set<ViewId>
}

export class TabManager {
  private readonly pty: PtyService
  private readonly byId = new Map<string, Tab>()
  /** projectId -> its tabs in display order. */
  private readonly order = new Map<string, Tab[]>()
  private readonly options: TabManagerOptions
  private readonly log: (message: string) => void
  /**
   * The colour the person last picked for a flag, app-wide (one person, one habit, every window):
   * what the flag command and "Edit note…" on an unflagged tab use. In memory only: forgetting it
   * at quit costs one pick, while saving it would be one more app setting nobody edits.
   */
  private lastFlagColor: FlagColor = DEFAULT_FLAG_COLOR
  /** The desktop's output of the tabs the terminal tap consumes (terminals/desktop-flow.ts). */
  private readonly desktop: DesktopFlow
  /**
   * Tabs the tap asked to take while the desktop owed more than VIEW_LOW_WATER of their output (web
   * access turned on while a page is behind, its pty perhaps paused on it). Taken then, the debt
   * would put the desktop `behind` on the next chunk and resync it from the copy, which for a tab
   * taken while running is a blank baseline: a page that had missed nothing would lose its screen
   * and scrollback. So the tab stays on the desktop's acks (today's path; the tap still numbers and
   * mirrors its output, its acks are ignored by the pty) and is taken once the desktop's acks bring
   * the debt down to VIEW_LOW_WATER (`ack`, `attach`). What the worker has not parsed of it by then
   * is not on main's count: its later acks land on the fresh one, clamped at zero (the next pause
   * comes a little later, as after any flow switch).
   */
  private readonly pendingTake = new Set<string>()
  /** Each view's size per tab and which one the pty takes (terminal-sizes.ts, design-web.md §5.2). */
  private readonly sizes: TerminalSizes
  /**
   * The `local` the desktop was last told per tab (`desktopSize`); absent means true, which is
   * where the page starts (it fits its pane until main says otherwise).
   */
  private readonly desktopLocal = new Map<string, boolean>()

  constructor(options: TabManagerOptions) {
    this.options = options
    this.log = options.log ?? warnLog
    this.pty = new PtyService({
      backend: options.backend,
      sink: {
        data: (id, chunk) => this.onData(id, chunk),
        exit: (id, code, signal) => this.onExit(id, code, signal)
      }
    })
    const tap = options.terminalTap
    this.sizes = new TerminalSizes({
      apply: (id, cols, rows) => this.applySize(id, cols, rows),
      // Server mode: only a browser's report counts. The hidden page's resize observer still runs
      // (at its 480x320 window), and as a tab's only view it would size the pty to that.
      ...(options.server === true ? { measured: (viewId: ViewId) => isRemoteViewId(viewId) } : {}),
      // A browser that drops and reconnects keeps the size it had (views/view-sizes.ts `hold`).
      ...(options.lineageOf ? { lineage: options.lineageOf, reconnectGraceMs: options.reconnectGraceMs ?? RECONNECT_GRACE_MS } : {}),
      ...(options.sizeDebounceMs === undefined ? {} : { debounceMs: options.sizeDebounceMs })
    })
    this.desktop = new DesktopFlow({
      emit: (tabId, data, reset, size) => {
        const tab = this.byId.get(tabId)
        if (!tab) return
        const payload: IpcEventMap['tabs.data'] = { tabId, data }
        if (reset) payload.reset = true
        if (size) this.desktopSize(tabId, payload, size.cols, size.rows)
        this.options.emit(tab.projectId, 'tabs.data', payload)
      },
      join: (tabId, view) => tap?.join?.(tabId, view),
      seq: (tabId) => tap?.seq?.(tabId),
      log: this.log
    })
    tap?.bindFlow?.({
      take: (id) => {
        // A desktop deep in debt keeps the pty until it has caught up (`pendingTake`).
        if (this.pty.flowOf(id) === 'view' && this.pty.unackedOf(id) > VIEW_LOW_WATER) {
          this.pendingTake.add(id)
          return
        }
        this.takeFlow(id)
      },
      ack: (id, count) => this.pty.ack(id, count, 'main'),
      release: (id) => {
        this.pendingTake.delete(id)
        // And back: the pty counts what the desktop still owes, so a page that is behind keeps
        // pausing Claude as it did before web access (today's path), rather than a fresh count.
        const owed = this.desktop.release(id)
        this.pty.setFlow(id, 'view', owed)
      },
      running: () => {
        const out: Array<{ tabId: string; cols: number; rows: number }> = []
        for (const id of this.byId.keys()) {
          const size = this.pty.sizeOf(id)
          if (size) out.push({ tabId: id, ...size })
        }
        return out
      },
      settled: (id) => this.desktop.settled(id),
      // An exited tab has no pty: PtyService.write ignores it (the query died with the process).
      reply: (id, data) => this.pty.write(id, data),
      askScreen: (id, ask) => {
        const tab = this.byId.get(id)
        if (!tab || !this.options.emitDesktop) return false
        return this.options.emitDesktop(tab.projectId, 'tabs.screenAsk', { tabId: id, id: ask.id, scrollback: ask.scrollback })
      }
    })
  }

  list(projectId: string): TabInfo[] {
    return (this.order.get(projectId) ?? []).map(info)
  }

  /**
   * The desktop renderer (re)attached and asked for its tabs. Output sent to the previous page was
   * never acknowledged, so forget it or a paused PTY would stay paused (see PtyService.resetFlow).
   * A tab main consumes (web access on) is resynced instead: the page gets a snapshot of it, its
   * screen back after a reload (DesktopFlow.resync). Never for a remote view (router.ts `tabs.list`).
   */
  attach(projectId: string): TabInfo[] {
    for (const tab of this.order.get(projectId) ?? []) {
      if (this.desktop.holds(tab.id)) this.desktop.resync(tab.id)
      else {
        this.pty.resetFlow(tab.id)
        this.takePending(tab.id)
      }
    }
    return this.list(projectId)
  }

  /**
   * Main consumes the tab's pty from now (TerminalFlow.take). Only a live pty (the tap asks right
   * after a spawn, or for a running tab when web access is turned on); a tab without one stays as
   * it is. What the desktop was sent and has not acked moves with it: its acks for that output now
   * land on the desktop's own count.
   */
  private takeFlow(id: string): void {
    this.pendingTake.delete(id)
    const owed = this.pty.flowOf(id) === 'view' ? this.pty.unackedOf(id) : 0
    if (this.pty.setFlow(id, 'main')) this.desktop.take(id, owed)
  }

  /** A tab waiting to be taken (`pendingTake`) is taken once the desktop's debt is down to VIEW_LOW_WATER. */
  private takePending(id: string): void {
    if (this.pendingTake.has(id) && this.pty.unackedOf(id) <= VIEW_LOW_WATER) this.takeFlow(id)
  }

  /** Start a tab. Throws (and creates nothing) for an unknown project, a bad cwd or a failed spawn. */
  create(projectId: string, { kind, cwd, prompt, model, effort }: CreateTabOptions): TabInfo {
    // Checked at run time as well: a command tab must come through createCommand, whose caller
    // looked the command up in main's settings, never through a kind someone passed along.
    if (kind !== 'claude' && kind !== 'shell') throw new Error('unknown tab kind')
    if (prompt && kind !== 'claude') throw new Error('only a Claude tab takes a prompt')
    if ((model !== undefined || effort !== undefined) && kind !== 'claude') {
      throw new Error('only a Claude tab takes a model or effort')
    }
    const out = this.add(projectId, kind, cwd, {
      ...(prompt === undefined ? {} : { prompt }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort })
    })
    this.changed(projectId)
    return out
  }

  /**
   * Start a command tab in the project folder: the login shell runs `command.command`
   * (commandArgv), the tab is titled `command.label`. The caller (index.ts) got both from
   * TabCommandsService.resolve, i.e. from the user's own settings by entry id; no IPC or plugin
   * path hands text here. The tab keeps this copy: editing the entry later changes nothing here.
   */
  createCommand(projectId: string, command: TabCommand): TabInfo {
    const out = this.add(projectId, 'command', undefined, { command: tabCommand(command) })
    this.changed(projectId)
    return out
  }

  /**
   * Start a command tab a plugin asked for (ctx.sessions.openCommand, through host-api, which took
   * the project from the host and spent the open budget): `argv` runs as is, with no shell, with the
   * same env, PATH and window token as every tab; `cwd` is realpath'd inside the project like any
   * tab's. The tab carries the plugin's id (and name) so the strip can say who opened it. Saved and
   * restored not started like a user's command tab, and dropped at restore once its plugin is gone.
   */
  createPluginCommand(projectId: string, { argv, cwd, title, openedBy, openedByName }: PluginCommandOptions): TabInfo {
    const command = tabCommand({
      label: title,
      argv,
      openedBy,
      ...(openedByName === undefined ? {} : { openedByName })
    })
    const out = this.add(projectId, 'command', cwd, { command })
    this.changed(projectId)
    return out
  }

  /**
   * Open a page tab (design-editor.md §1): a plugin's page in the tab bar, with no process. The
   * caller took `spec.plugin` from the host's own plugin and checked the type against that
   * plugin's manifest (`contributes.tabs`); the spec is checked again here (plain JSON params under
   * the cap, title clamped, a bad icon dropped) and the per-plugin cap applies. Opened while another
   * tab is selected and not `focus`ed (the window selects a focused one at once), it carries the
   * unseen dot until a view shows it (markSeen).
   */
  createPage(projectId: string, spec: PageTabSpec, { focus = false }: { focus?: boolean } = {}): TabInfo {
    const page = checkPageTabSpec(spec, isPluginId)
    const unseen = !focus && this.selectedOf(projectId) !== undefined
    const out = this.addPage(projectId, page, unseen)
    this.changed(projectId)
    return out
  }

  /**
   * A view of `projectId` showed the tab (`tabs.selected`): its unseen dot goes. The tab as it is
   * now when that changed something (the caller tells every view), else undefined.
   */
  markSeen(projectId: string, tabId: string): TabInfo | undefined {
    const tab = this.find(projectId, tabId)
    if (!tab?.unseen) return undefined
    delete tab.unseen
    return info(tab)
  }

  /**
   * A page tab's plugin points at it again (ctx.tabs.markUnseen, the editor's `ccc edit` on a file
   * that already has a tab): it gets the unseen dot back unless the project shows it now (the
   * selection of the view that acted last, as at open) or it has the dot already. Only a page tab;
   * the caller checked it is that plugin's own. The tab as it is now when that changed something
   * (the caller tells every view), else undefined.
   */
  markUnseen(projectId: string, tabId: string): TabInfo | undefined {
    const tab = this.find(projectId, tabId)
    if (tab?.kind !== 'page' || tab.unseen) return undefined
    const shown = this.selectedOf(projectId)
    if (shown === undefined || shown === tabId) return undefined
    tab.unseen = true
    return info(tab)
  }

  /**
   * A page tab's title and icon from its plugin (ctx.tabs, a PageTabInstance's setTitle; HostApi
   * checked the tab is that plugin's). Checked and clamped again here as at open (pageTabTitleOf,
   * a bad icon refused rather than dropped: the caller asked for it by name). `icon` undefined keeps
   * the current one. Saved with the tab and told to every view (`tabs.added`) when it changed.
   */
  setPageTitle(projectId: string, tabId: string, title: unknown, icon?: unknown): void {
    const tab = this.require(projectId, tabId)
    if (tab.kind !== 'page' || !tab.page) throw new Error('only a page tab has a title of its own')
    const t = pageTabTitleOf(title)
    if (t === undefined) throw new Error('a page tab needs a title of plain text')
    const i = icon === undefined ? tab.page.icon : pageTabIconOf(icon)
    if (icon !== undefined && i === undefined) throw new Error('a page tab icon must be a glyph name')
    if (tab.page.title === t && tab.page.icon === i) return
    const page: PageTabSpec = { ...tab.page, title: t }
    if (i === undefined) delete page.icon
    else page.icon = i
    tab.page = page
    this.options.emit(projectId, 'tabs.added', info(tab))
    this.changed(projectId)
  }

  /**
   * `viewId`'s page of a page tab says whether it holds unsaved changes (`pageTabs.dirty`, the view
   * main bound the sender to). Dirty is per (tab, view): one browser's unsaved buffer is not the
   * desktop's. When the tab's dirty-in-any-view changes, every view of the project is told the tab
   * as it is now (`tabs.added`, merged by id and generation). Anything but a page tab of the project
   * is ignored: a report is a page's word about itself, and it can never stop a close.
   */
  setPageDirty(projectId: string, tabId: string, viewId: ViewId, dirty: boolean): void {
    const tab = this.find(projectId, tabId)
    if (!tab || tab.kind !== 'page') return
    const was = (tab.dirtyIn?.size ?? 0) > 0
    if (dirty) (tab.dirtyIn ??= new Set()).add(viewId)
    else tab.dirtyIn?.delete(viewId)
    if (tab.dirtyIn?.size === 0) delete tab.dirtyIn
    if (was !== (tab.dirtyIn !== undefined)) this.options.emit(projectId, 'tabs.added', info(tab))
  }

  /** Whether a page tab of `projectId` holds unsaved changes in some view (`tabs.close` asks first then). */
  pageUnsaved(projectId: string, tabId: string): boolean {
    const tab = this.find(projectId, tabId)
    return tab?.kind === 'page' && tab.dirtyIn !== undefined
  }

  /**
   * Everything `viewId` said about unsaved changes is void: the view left (its pages went with it) or
   * its page reloaded (the desktop shell: its frames went). Each tab that is clean now is told.
   */
  clearViewDirty(viewId: ViewId): void {
    for (const tab of this.byId.values()) {
      if (!tab.dirtyIn?.delete(viewId)) continue
      if (tab.dirtyIn.size > 0) continue
      delete tab.dirtyIn
      this.options.emit(tab.projectId, 'tabs.added', info(tab))
    }
  }

  /**
   * The project's page tabs dirty in any view, as their titles in tab order: what closing the
   * window or quitting asks about (design-editor.md §1, unsaved-dialog.ts).
   */
  unsavedTitles(projectId: string): string[] {
    return (this.order.get(projectId) ?? []).flatMap((t) => (t.dirtyIn !== undefined && t.page ? [t.page.title] : []))
  }

  /**
   * Bring a saved tab back at start. Not reachable from a renderer or plugin (no IPC channel
   * maps here): `resumeId` is text from a hook payload that was saved to disk, and restore.ts
   * validated it before it gets here. A Claude tab keeps the id as its own `sessionId` right
   * away, so quitting again before the SessionStart hook reports does not lose the session.
   */
  restoreTab(projectId: string, { kind, cwd, resumeId, command, name, flag, room, page }: RestoreTabOptions): TabInfo {
    // Re-read like the name: a bad saved flag only loses the flag. Any kind keeps one.
    const savedFlag = flag === undefined ? undefined : tabFlagOf(flag)
    const flagOpt = savedFlag === undefined ? {} : { flag: savedFlag }
    if (kind === 'page') {
      if (resumeId !== undefined || command !== undefined || name !== undefined) throw new Error('a page tab has no session or command')
      if (!page) throw new Error('a page tab needs its plugin, type and title')
      // Not unseen: the person had it open when the app quit.
      return this.addPage(projectId, checkPageTabSpec(page, isPluginId), false, savedFlag)
    }
    if (page !== undefined) throw new Error('only a page tab has a page')
    if (kind !== 'claude' && kind !== 'shell' && kind !== 'command') throw new Error('unknown tab kind')
    if (resumeId !== undefined && kind !== 'claude') throw new Error('only a Claude tab resumes')
    if (kind === 'command') {
      if (!command) throw new Error('a command tab needs its command')
      // Restored NOT started: a command may be anything (a deploy, a migration, a cleanup), and
      // the app launching must never run one by itself. The tab comes back stopped with its
      // banner; the user's Restart runs it. The same for a plugin's argv (re-checked by tabCommand).
      return this.add(projectId, kind, cwd, { command: tabCommand(command), start: false, ...flagOpt })
    }
    if (command !== undefined) throw new Error('only a command tab has a command')
    if (name !== undefined && kind !== 'claude') throw new Error('only a Claude tab has a name')
    const checked = name === undefined ? undefined : checkSessionName(name)
    // A bad saved name only loses the name: the tab and its session still come back.
    const kept = checked?.ok ? (checked.value ?? undefined) : undefined
    // Membership is a Claude tab's only; a bad saved value only loses it (tabRoomOf), like the name.
    const savedRoom = kind === 'claude' && room !== undefined ? tabRoomOf(room) : undefined
    return this.add(projectId, kind, cwd, {
      ...(resumeId === undefined ? {} : { resumeId }),
      ...(kept === undefined ? {} : { name: kept }),
      ...flagOpt,
      ...(savedRoom === undefined ? {} : { room: savedRoom })
    })
  }

  /**
   * A page tab into the project's order: no pty, no token (resolveToken skips ''), no lifecycle
   * `started` (the session registry has no entry for it, so the send gate, `typed` and Claude status
   * never apply), cwd the project folder. gen 1 and no exit: it is never "not started" or exited.
   */
  private addPage(projectId: string, page: PageTabSpec, unseen: boolean, flag?: TabFlag): TabInfo {
    const root = this.projectRoot(projectId)
    const tabs = this.order.get(projectId) ?? []
    const mine = tabs.filter((t) => t.page?.plugin === page.plugin).length
    if (mine >= MAX_PAGE_TABS_PER_PLUGIN) {
      throw new Error(`a plugin may keep at most ${MAX_PAGE_TABS_PER_PLUGIN} page tabs open in a project`)
    }
    const tab: Tab = {
      id: randomUUID(),
      projectId,
      kind: 'page',
      cwd: resolveCwd(root, undefined),
      gen: 1,
      spawnedAt: 0,
      token: '',
      resumable: false,
      resuming: false,
      resumeFailed: false,
      page
    }
    if (unseen) tab.unseen = true
    if (flag !== undefined) tab.flag = { ...flag }
    this.byId.set(tab.id, tab)
    tabs.push(tab)
    this.order.set(projectId, tabs)
    return info(tab)
  }

  /** The project's selected tab, any kind; a throwing source reads as none (no unseen dot). */
  private selectedOf(projectId: string): string | undefined {
    try {
      return this.options.selectedTab?.(projectId)
    } catch (err) {
      this.log(`selected tab lookup failed: ${errorText(err)}`)
      return undefined
    }
  }

  private add(
    projectId: string,
    kind: TabKind,
    cwd: string | undefined,
    opts: {
      prompt?: string
      model?: string
      effort?: string
      resumeId?: string
      command?: AnyTabCommand
      start?: boolean
      name?: string
      flag?: TabFlag
      room?: TabRoom
    }
  ): TabInfo {
    const root = this.projectRoot(projectId)
    const tab: Tab = {
      id: randomUUID(),
      projectId,
      kind,
      cwd: resolveCwd(root, cwd),
      gen: 0,
      spawnedAt: 0,
      token: '',
      resumable: false,
      resuming: false,
      resumeFailed: false
    }
    if (opts.command) tab.command = opts.command
    // Set before start() so the registry's entry is born with it (a restored tab shows its name at once).
    if (opts.name !== undefined) tab.name = opts.name
    if (opts.flag !== undefined) tab.flag = { ...opts.flag }
    // Before start() too: the registry binds the new id first, and the session registry's entry is
    // born typed (a restored member is the person's; TabEvent.typed).
    if (opts.room !== undefined) {
      const room = this.rebindRoom(tab.id, opts.room)
      if (room !== undefined) {
        tab.room = room
        tab.restoredMember = true
      }
    }
    const started = opts.start !== false
    if (started) {
      try {
        this.start(tab, opts.prompt, opts.resumeId, opts.model, opts.effort)
      } catch (err) {
        // The registry bound the new id above; a tab that never came to be must not hold the member.
        // `gone`, not `closed`: the restorer keeps the record for the next launch (restore.ts unrestored).
        this.roomTabGone(tab, 'gone')
        throw err
      }
    } else {
      // Not spawned: gen stays 0 and the tab reads as exited, so the banner, the strip's
      // "(exited)" mark, restart()'s guard and close()'s no-op terminate treat it like any
      // stopped tab (TabInfo.notStarted says which words to show).
      tab.exit = { code: 0, signal: null }
    }
    if (opts.resumeId !== undefined) {
      tab.sessionId = opts.resumeId
      tab.resumable = true
    }
    this.byId.set(tab.id, tab)
    const tabs = this.order.get(projectId) ?? []
    tabs.push(tab)
    this.order.set(projectId, tabs)
    // Nothing started for a waiting tab: listeners hear of it at its first Restart.
    if (started) this.notify((l) => l.started?.(tabEvent(tab)))
    return info(tab)
  }

  /**
   * Kill the PTY and forget the tab. Its late exit event is dropped (no tab to report to). SIGHUP
   * first, SIGKILL after a grace period: once the tab is gone nothing is left to stop a child
   * that traps HUP (PtyService.terminate).
   */
  close(projectId: string, tabId: string): void {
    this.closeTab(this.require(projectId, tabId))
  }

  /**
   * The one way a single tab ends, for the user's Close and a clean exit alike (onExit): the
   * session registry hears `closed`, restore.ts saves the record without the tab. A no-op
   * terminate for a tab whose process already exited.
   */
  private closeTab(tab: Tab): void {
    this.remove(tab, 'closed')
    this.pty.terminate(tab.id)
    this.changed(tab.projectId)
  }

  /**
   * Name a Claude tab (`null`: back to Claude's own title). The tab is looked up in `projectId`
   * only, so another project's id reads as unknown. Saved with the tab (changed) and told to the
   * registry, whose snapshot the windows show it from. Throws for a bad name (shared/session-name.ts).
   */
  rename(projectId: string, tabId: string, name: string | null): void {
    const tab = this.require(projectId, tabId)
    if (tab.kind !== 'claude') throw new Error('only a Claude tab can be renamed')
    const checked = checkSessionName(name)
    if (!checked.ok) throw new Error(checked.reason)
    if ((tab.name ?? null) === checked.value) return
    if (checked.value === null) delete tab.name
    else tab.name = checked.value
    this.notify((l) => l.renamed?.(tab.id, checked.value))
    this.changed(projectId)
  }

  /**
   * The person's flag on a tab of `projectId` (any kind): set, change its colour or note, or clear
   * it with `null` (shared/tab-flag.ts FlagPatch). The ONLY writer, reached from the shell page's
   * `tabs.flag` IPC alone (the router takes it from the project window's top frame, so no plugin
   * panel, overlay or web view can send it, and host-api has no way in): a flag means "the person
   * marked this", which a plugin setting it would make worthless. The tab is looked up in
   * `projectId` only, so another window's tab id reads as unknown. Saved with the tab (changed),
   * told to the session registry for SessionInfo.flag. Returns the flag as stored (null: none).
   */
  setFlag(projectId: string, tabId: string, patch: unknown): TabFlag | null {
    const tab = this.require(projectId, tabId)
    const checked = checkFlagPatch(patch)
    if (!checked.ok) throw new Error(checked.reason)
    if (checked.value?.color !== undefined) this.lastFlagColor = checked.value.color
    const next = checked.value === null ? undefined : applyFlagPatch(tab.flag, checked.value, this.lastFlagColor)
    this.storeFlag(tab, next)
    return next === undefined ? null : { ...next }
  }

  /**
   * The flag command (`tabs.toggleFlag`): a flagged tab loses its flag (note included: toggling
   * off is the quick "done with it"), an unflagged one gets the last-used colour. Same scoping and
   * same single path as setFlag.
   */
  toggleFlag(projectId: string, tabId: string): TabFlag | null {
    const tab = this.require(projectId, tabId)
    const next = tab.flag === undefined ? { color: this.lastFlagColor } : undefined
    this.storeFlag(tab, next)
    return next === undefined ? null : { ...next }
  }

  private storeFlag(tab: Tab, next: TabFlag | undefined): void {
    if (sameFlag(tab.flag, next)) return
    if (next === undefined) delete tab.flag
    else tab.flag = next
    this.notify((l) => l.flagged?.(tab.id, next === undefined ? null : { ...next }))
    this.changed(tab.projectId)
  }

  /**
   * The tab joined a room (the room service, after RoomRegistry.addMember or redeem): main-internal,
   * never reached from IPC, a plugin or a hook with a payload's membership. A Claude tab of
   * `projectId` only. A new membership starts unmarked, so a mark the person gave for one room never
   * carries into another (design-rooms.md §2 "The mark"). Saved with the tab and told to every view.
   */
  setRoom(projectId: string, tabId: string, room: { id: string; name: string; coordinator: boolean }): TabRoom {
    const tab = this.require(projectId, tabId)
    if (tab.kind !== 'claude') throw new Error('only a Claude tab can be in a room')
    const next = tabRoomOf({ id: room.id, name: room.name, coordinator: room.coordinator, mark: false })
    if (next === undefined) throw new Error('not a valid room membership')
    // The same room and name keeps the mark (a coordinator change is not a new membership).
    if (tab.room?.id === next.id && tab.room.name === next.name) next.mark = tab.room.mark
    this.storeRoom(tab, next)
    return { ...next }
  }

  /** The tab left its room (left, removed, the room ended): the membership and its mark go. A no-op for a tab in none. */
  clearRoom(projectId: string, tabId: string): void {
    const tab = this.find(projectId, tabId)
    if (tab) this.storeRoom(tab, undefined)
  }

  /**
   * The person's mark on a member tab of `projectId` ("Deliver room messages automatically",
   * design-rooms.md §2). The ONLY writer of the mark, for the shell page's `tabs.roomMark` IPC alone
   * (the flag's pattern, setFlag): a mark lets room messages into a tab the person typed in, so a
   * plugin, hook or `ccc` path that could set it would make it worthless. Throws for a tab in no
   * room. Returns the mark as stored.
   */
  setRoomMark(projectId: string, tabId: string, mark: unknown): boolean {
    const tab = this.require(projectId, tabId)
    if (typeof mark !== 'boolean') throw new Error('mark must be true or false')
    if (!tab.room) throw new Error('the tab is in no room')
    this.storeRoom(tab, { ...tab.room, mark })
    return mark
  }

  /** The tab's membership and mark, if any (the room delivery reads the mark here). */
  roomOf(projectId: string, tabId: string): TabRoom | undefined {
    const room = this.find(projectId, tabId)?.room
    return room ? { ...room } : undefined
  }

  private storeRoom(tab: Tab, next: TabRoom | undefined): void {
    if (sameTabRoom(tab.room, next)) return
    if (next === undefined) delete tab.room
    else tab.room = next
    this.notify((l) => l.roomChanged?.(tab.id, next === undefined ? null : { ...next }))
    // Every view, the asking one included: a membership changes on main's side (a `ccc room join`, a
    // plugin's open), never as the reply to a view's request.
    this.options.emit(tab.projectId, 'tabs.added', info(tab))
    this.changed(tab.projectId)
  }

  /**
   * A saved membership asked of the registry (TabRoomHooks.rebind); dropped on a throw and with no registry: the
   * saved file is user-writable, and a mark (the person's safety switch) nobody confirmed must not come back.
   */
  private rebindRoom(tabId: string, saved: TabRoom): TabRoom | undefined {
    const hooks = this.options.rooms
    if (!hooks) return undefined
    try {
      const bound = hooks.rebind(tabId, { id: saved.id, name: saved.name })
      return bound === undefined ? undefined : { ...saved, coordinator: bound.coordinator === true }
    } catch (err) {
      this.log(`room rebind failed: ${errorText(err)}`)
      return undefined
    }
  }

  /** Tell the room registry a member tab is gone: for good (`closed`) or with its window or the app (`gone`). */
  private roomTabGone(tab: Tab, why: 'closed' | 'gone'): void {
    const hooks = this.options.rooms
    const room = tab.room
    if (!hooks || !room) return
    try {
      if (why === 'closed') hooks.closed(tab.id, { ...room })
      else hooks.gone(tab.id)
    } catch (err) {
      this.log(`room hook failed: ${errorText(err)}`)
    }
  }

  /** Move to `toIndex` in the project's order, clamped to the ends. */
  reorder(projectId: string, tabId: string, toIndex: number): void {
    const tab = this.require(projectId, tabId)
    if (!Number.isInteger(toIndex)) throw new Error('toIndex must be an integer')
    const tabs = this.order.get(projectId)
    if (!tabs) return
    tabs.splice(tabs.indexOf(tab), 1)
    tabs.splice(Math.min(Math.max(toIndex, 0), tabs.length), 0, tab)
    this.changed(projectId)
  }

  /**
   * Put the project's tabs in `ids`' order (TabGroups after a group op: every group contiguous, a
   * placed tab next to its anchor). Ids that are not the project's are skipped, and a tab `ids`
   * leaves out keeps its relative place at the end, so a stale list can never drop or duplicate a
   * tab. Not a save: TabGroups saves tabs and groups together once its edit is applied.
   */
  setOrder(projectId: string, ids: readonly string[]): void {
    const tabs = this.order.get(projectId)
    if (!tabs) return
    const seen = new Set<Tab>()
    const next: Tab[] = []
    for (const id of ids) {
      const tab = this.find(projectId, id)
      if (!tab || seen.has(tab)) continue
      seen.add(tab)
      next.push(tab)
    }
    for (const tab of tabs) if (!seen.has(tab)) next.push(tab)
    tabs.splice(0, tabs.length, ...next)
  }

  /**
   * Relaunch an exited tab in place: same id (the renderer keeps its xterm and position), same
   * kind and cwd, `--resume` when the session has a conversation to resume and its last resume
   * did not die before starting (else a fresh `claude`, see Tab.resumeFailed), and a fresh token
   * so the dead process's token stops working. A command tab runs its own copy of the command
   * again; a restored one that never ran (gen 0) runs it for the first time.
   */
  restart(projectId: string, tabId: string): TabInfo {
    const tab = this.require(projectId, tabId)
    if (tab.kind === 'page') throw new Error('a page tab has no process to restart')
    if (!tab.exit) throw new Error('tab is still running')
    // The folder may have been moved or deleted while the tab sat exited; check again.
    tab.cwd = resolveCwd(this.projectRoot(projectId), tab.cwd)
    this.start(tab, undefined, tab.resumable && !tab.resumeFailed ? tab.sessionId : undefined)
    tab.exit = undefined
    this.notify((l) => l.started?.(tabEvent(tab)))
    // The cwd may have been re-resolved above.
    this.changed(projectId)
    return info(tab)
  }

  /** Text for the PTY as it is (the send gate's paste goes here). Unknown tabs are ignored. */
  input(projectId: string, tabId: string, data: string): void {
    // A page tab has no pty: nothing (the send gate's paste included) is ever written for it.
    const tab = this.terminalTab(projectId, tabId)
    if (tab) this.pty.write(tab.id, data)
  }

  /**
   * A view's terminal input (the desktop's or a remote view's xterm `onData`: keys, a paste, and
   * the reports xterm writes by itself). While the terminal tap answers the tab's queries (web
   * access on, design-web.md §5.2 "Main answers terminal queries"), every view's own query replies
   * are stripped first (terminal-reports.ts stripQueryReplies): with two views awake the program
   * would otherwise get two answers to one query and read the second as typed text. Focus and
   * mouse reports pass from any view, and a reply glued to a key keeps the key. Off, the chunk goes
   * as it is: the desktop answers as before. Returns what reached the pty ('' for an unknown tab).
   */
  viewInput(projectId: string, tabId: string, data: string, viewId: ViewId = DESKTOP_VIEW): string {
    // A page tab is never typed into as a terminal: no pty write, no size take, no `typedBy`.
    const tab = this.terminalTab(projectId, tabId)
    if (!tab) return ''
    let answers = false
    this.tap((t) => {
      answers = t.answers?.(tab.id) ?? false
    })
    const rest = answers ? stripQueryReplies(data) : data
    if (rest.length > 0) this.pty.write(tab.id, rest)
    // The same rule as SessionInfo.typed (terminal-reports.ts): a focus or mouse report, which a
    // view sends just by being clicked into, is not the person typing there, and neither is a
    // query reply every awake view's xterm writes by itself.
    if (!isPersonInput(rest)) return rest
    // Typing after another view typed takes the terminal's size (after the debounce). Only the
    // person's input: with a reply counted, whichever view answered Claude's start-up queries last
    // took the pty size, and the sizing view's own reply cancelled another view's pending take.
    this.sizes.typed(tab.id, viewId)
    this.typedIn(tab, viewId)
    return rest
  }

  /**
   * The person typed in `viewId` (design-web.md §5.2 "Input from any view": each view shows which
   * device typed last in a tab). Told to every view of the project (`tabs.typed`) only when the
   * view changes, never per key; each page decides whether that is itself (renderer shell-kind.ts).
   */
  private typedIn(tab: Tab, viewId: ViewId): void {
    if (tab.typedBy?.viewId === viewId) return
    const device = this.options.deviceOf?.(viewId) ?? (isRemoteViewId(viewId) ? 'a browser' : 'Desktop')
    tab.typedBy = { viewId, device }
    this.options.emit(tab.projectId, 'tabs.typed', { tabId: tab.id, viewId, device })
  }

  /**
   * A view measured the tab's pane (its resize observer). Remembered per view; the pty takes it only
   * when that view sizes the tab (terminal-sizes.ts): another view's resize does not redraw Claude.
   */
  resize(projectId: string, tabId: string, cols: number, rows: number, viewId: ViewId = DESKTOP_VIEW): void {
    // Renderer-supplied: a junk size is not even remembered (PtyService would refuse it anyway).
    // A page tab has no terminal to size.
    const tab = this.terminalTab(projectId, tabId)
    if (!tab || !validSize(cols, rows)) return
    this.sizes.report(tab.id, viewId, cols, rows)
  }

  /**
   * "Fit to this screen": the view takes the tab's size now. False when the view has not reported a
   * size for the tab (it has not shown it) or is hidden.
   */
  fit(projectId: string, tabId: string, viewId: ViewId = DESKTOP_VIEW): boolean {
    const tab = this.terminalTab(projectId, tabId)
    return tab ? this.sizes.take(tab.id, viewId) : false
  }

  /** A view was hidden or shown (a minimized window, a background browser tab): hidden ones never size. */
  viewVisible(viewId: ViewId, visible: boolean): void {
    this.sizes.visible(viewId, visible)
  }

  /** A view is gone (a browser's connection closed): its tabs' sizes fall back to a remaining view. */
  viewGone(viewId: ViewId): void {
    this.sizes.viewGone(viewId)
    // Its page tab frames went with it: their unsaved changes are no longer anywhere to lose.
    this.clearViewDirty(viewId)
    // A view that left is not "the last typist" (and a reconnecting browser gets a fresh id, so its
    // own old typing would read as another device's): clear it and tell the remaining views.
    for (const tab of this.byId.values()) {
      if (tab.typedBy?.viewId !== viewId) continue
      delete tab.typedBy
      this.options.emit(tab.projectId, 'tabs.typed', { tabId: tab.id, viewId: null, device: null })
    }
  }

  /**
   * The tab's terminal size in cells now: its pty's, else the size its sizing view reported (an exited
   * tab), else undefined. Only a tab of `projectId` (TabGroups' minimum check for a plugin's `beside`).
   */
  sizeOf(projectId: string, tabId: string): { cols: number; rows: number } | undefined {
    const tab = this.find(projectId, tabId)
    if (!tab) return undefined
    const size = this.pty.sizeOf(tab.id) ?? this.sizes.sizeOf(tab.id)
    return size ? { cols: size.cols, rows: size.rows } : undefined
  }

  /**
   * A tab's kind, undefined for an unknown id or another project's: TabGroups' check that only
   * terminal tabs become panes (a page tab never does, shared/tab-groups.ts isPaneKind).
   */
  kindOf(projectId: string, tabId: string): TabKind | undefined {
    return this.find(projectId, tabId)?.kind
  }

  /** The view whose size the tab's pty has (tests, diagnostics, the terminal colour answer in index.ts). */
  sizerOf(tabId: string): ViewId | undefined {
    return this.sizes.sizerOf(tabId)
  }

  /**
   * The view the person last typed in on the tab (TabInfo.typedBy's view), undefined when nobody
   * typed or that view left. Main's own record, keyed by main's tab id: the mirror's OSC colour
   * answers follow that view's theme (ThemeService.forTerminal).
   */
  typedByView(tabId: string): ViewId | undefined {
    return this.byId.get(tabId)?.typedBy?.viewId
  }

  /**
   * The pty takes a size: the terminal tap numbers it in the tab's stream (remote views get it as a
   * `term.data` size item), and the desktop gets it as a `tabs.data` size item in the same order as
   * its output, so every copy wraps the lines before it at the old size and the ones after at the
   * new. While the desktop is behind or resyncing, its join delivers the size instead (DesktopFlow).
   * A size the pty already has is nothing (no item anywhere).
   */
  private applySize(id: string, cols: number, rows: number): void {
    const tab = this.byId.get(id)
    if (!tab) return
    const before = this.pty.sizeOf(id)
    if (!before) {
      // An exited tab has no pty to resize, but a desktop following the pty's size still draws it
      // at the size it was told, so a window resize or "Fit to this screen" must still reach it: a
      // size item for the desktop only. Remote views have nothing to wrap, and a restart spawns at
      // the sizer's remembered size.
      this.emitDesktopSize(tab, cols, rows)
      return
    }
    if (before.cols === cols && before.rows === rows) {
      // The sizer changed but not the size (a browser left and the desktop sizes again at the same
      // size): no item for the pty or remote views, but a desktop that was following must hear it
      // fits its pane again, or it would keep lagging a round trip behind its own window.
      if ((this.desktopLocal.get(id) ?? true) !== this.desktopSizes(id)) this.emitDesktopSize(tab, cols, rows)
      return
    }
    if (!this.pty.resize(id, cols, rows)) return
    this.emitDesktopSize(tab, cols, rows)
    this.tap((t) => t.resized(id, cols, rows))
  }

  /**
   * Whether the desktop sizes the tab's pty, so its page fits its pane itself (`tabs.data` `local`):
   * it is the sizer, or nobody is (a tab no view has measured yet). With web access off the desktop
   * is the only view and always so: the terminal follows a window drag at once, as before Task 15.
   */
  private desktopSizes(id: string): boolean {
    // Server mode: never. The hidden page follows the pty's size (it answers `tabs.screenAsk`, whose
    // screen must wrap as the pty's), and nobody sizing does not make it the sizer.
    if (this.options.server === true) return false
    const sizer = this.sizes.sizerOf(id)
    return sizer === undefined || !isRemoteViewId(sizer)
  }

  /** Sets a size (an item's or a snapshot's) on a desktop `tabs.data`, with `local` (desktopSizes). */
  private desktopSize(id: string, payload: IpcEventMap['tabs.data'], cols: number, rows: number): void {
    payload.cols = cols
    payload.rows = rows
    const local = this.desktopSizes(id)
    if (local) payload.local = true
    this.desktopLocal.set(id, local)
  }

  /** A size item for the desktop, in order with its output (unless its resync delivers sizes). */
  private emitDesktopSize(tab: Tab, cols: number, rows: number): void {
    if (!this.desktop.passes(tab.id)) return
    const payload: IpcEventMap['tabs.data'] = { tabId: tab.id, data: '' }
    this.desktopSize(tab.id, payload, cols, rows)
    this.options.emit(tab.projectId, 'tabs.data', payload)
  }

  /**
   * The desktop page's screen of a tab, answering main's `tabs.screenAsk` (router `tabs.screen`,
   * desktop views only). Only a tab of the sender's project reaches the tap, which checks the rest.
   */
  screen(projectId: string, tabId: string, answer: ScreenAnswer): void {
    // A page tab has no terminal: nothing to answer with, and the ask would hang.
    const tab = this.terminalTab(projectId, tabId)
    if (!tab) return
    this.tap((t) => t.screen?.(tab.id, answer))
  }

  /** The desktop renderer's ack: the pty's flow, or the desktop's own while main consumes the pty. */
  ack(projectId: string, tabId: string, count: number): void {
    const tab = this.terminalTab(projectId, tabId)
    if (!tab) return
    if (this.desktop.holds(tab.id)) this.desktop.ack(tab.id, count)
    else {
      this.pty.ack(tab.id, count)
      this.takePending(tab.id)
    }
  }

  /**
   * A SessionStart hook reported `sessionId` (already checked against SESSION_ID) with the
   * payload's `source`; called for every SessionStart, also one that repeats the id, because it
   * ends `resuming`. A new id is resumable as the first report of a resumed process (see
   * Tab.resuming), or when `source` is `resume` or `fork`: the user picked a stored conversation
   * with the interactive `/resume` (or forked one) inside a running tab, which reports a
   * SessionStart under that conversation's id while `resuming` is long false; without this the
   * record dropped the id and a quit before the next prompt restarted the tab fresh. claude
   * 2.1.314's sources are startup|resume|clear|compact|fork, and it groups fork with startup and
   * resume as the start of a session, not a reset; a fork carries the conversation it came from.
   * `clear` and `startup` stay unresumable until a prompt: an empty session `--resume` may not
   * find. `compact` repeats the live id (returned early below). After a failed resume
   * (Tab.resumeFailed) this is the fresh process's report: its new id replaces the saved one below
   * (resumed false, wasSaved true), and only now is the old id dropped.
   */
  sessionStarted(tabId: string, sessionId: string, source?: string): void {
    const tab = this.byId.get(tabId)
    if (!tab) return
    const resumed = tab.resuming || source === 'resume' || source === 'fork'
    tab.resuming = false
    tab.resumeFailed = false
    if (tab.sessionId === sessionId) return
    const wasSaved = tab.resumable
    tab.sessionId = sessionId
    tab.resumable = resumed
    // Only a resumable id is saved (info()). The saved shape changed when the new id is saved, and
    // also when the old one was: after `/clear` in a prompted session the record still names the
    // cleared conversation, and quitting before any other tab change would resume it next launch.
    if (resumed || wasSaved) this.changed(tab.projectId)
  }

  /** A UserPromptSubmit hook: the session now has a conversation `--resume` finds. */
  sessionPrompted(tabId: string): void {
    const tab = this.byId.get(tabId)
    if (!tab || tab.sessionId === undefined || tab.resumable) return
    tab.resumable = true
    this.changed(tab.projectId)
  }

  /**
   * What a socket token belongs to (socket-server.ts resolves every tokened request here, then
   * OverlayManager.resolveToken). The kind is decided HERE, from the tab's own kind, never from
   * anything the caller sent: a Claude tab's token is a session token (the tab is a Claude
   * session); a shell or command tab's is a window token, which only names the tab's project, as
   * `--project` would (design §2), and carries no tab id so it can never stand for a session.
   * Every candidate is compared with timingSafeEqual and the walk does not stop at a match, so the
   * time taken says nothing about how close a guess was. A tab keeps its token after its process
   * exits (a SessionEnd hook can land just after the exit; a shell's leftover background job may
   * still call `ccc`) until a restart replaces it or the tab closes. A restored command tab that
   * never started has no token (''), which TOKEN_RE skips.
   */
  resolveToken(token: string): TokenOwner | undefined {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined
    const wanted = Buffer.from(token, 'hex')
    let found: Tab | undefined
    for (const tab of this.byId.values()) {
      if (!TOKEN_RE.test(tab.token)) continue
      if (timingSafeEqual(wanted, Buffer.from(tab.token, 'hex')) && !found) found = tab
    }
    if (!found) return undefined
    return found.kind === 'claude'
      ? { kind: 'session', tabId: found.id, projectId: found.projectId }
      : { kind: 'window', projectId: found.projectId }
  }

  /** A project window closed: its terminals die with it (SIGKILL after the grace period, as close). */
  closeProject(projectId: string): void {
    for (const tab of [...(this.order.get(projectId) ?? [])]) {
      // A window closing is not the person closing its tabs: members stay (design-rooms.md §1).
      this.remove(tab, 'gone')
      this.pty.terminate(tab.id)
    }
  }

  /** App quit. Members stay members (design-rooms.md §1): only their tab binding goes. */
  disposeAll(): void {
    for (const tab of this.byId.values()) this.roomTabGone(tab, 'gone')
    this.pty.disposeAll()
    this.byId.clear()
    this.order.clear()
  }

  /**
   * Spawn the tab's process. `prompt` is for a brand-new Claude tab only; a restart passes the
   * session id to resume instead. Throws before touching any state when the spawn fails.
   */
  private start(tab: Tab, prompt?: string, resumeId?: string, model?: string, effort?: string): void {
    const token = randomBytes(32).toString('hex')
    const argv =
      tab.kind === 'claude'
        ? claudeArgv({
            hooksPath: this.options.hooksPath,
            pluginDirs: this.options.pluginDirsFor?.(tab.projectId) ?? [],
            resumeId,
            prompt,
            model,
            effort
          })
        : tab.kind === 'command'
          ? commandArgvOf(this.shell(), requireCommand(tab))
          : shellArgv(this.shell())
    const env = buildPtyEnv(this.options.loginEnv(), {
      binDir: this.options.binDir,
      // Every kind gets a token and the socket: a Claude tab's is a session token, a shell or
      // command tab's a window token (resolveToken), so `ccc browser open …` or `ccc plugin link`
      // typed in a shell tab, or chained after `npm run dev &` in a command tab, reaches this
      // window without `--project`. Main refuses a window token for `hook` and `session.*`.
      tab: { tabId: tab.id, token, sock: this.options.sock() }
    })
    // A restart at the size the sizing view has (a new tab has none yet: the default; server mode's
    // is larger, as no desktop page will measure the tab right after).
    const { cols, rows } =
      this.sizes.sizeOf(tab.id) ??
      (this.options.server === true ? { cols: SERVER_INITIAL_COLS, rows: SERVER_INITIAL_ROWS } : { cols: INITIAL_COLS, rows: INITIAL_ROWS })
    this.pty.spawn(tab.id, argv, { cwd: tab.cwd, env, cols, rows })
    // Terminal tap: after a spawn that worked and before any output (node-pty reads on a later tick).
    this.tap((t) => t.spawned(tab.id, cols, rows))
    // The desktop's copy of a restarted tab is told the size too (a new tab's page has drawn nothing
    // yet and sends its own size first). Ordered before any output: node-pty reads on a later tick.
    // Server mode tells a new tab's hidden page too: its own size counts for nothing, so it must draw
    // at the pty's from the first byte.
    if (tab.gen > 0 || this.options.server === true) this.emitDesktopSize(tab, cols, rows)
    // After the spawn: a failed one leaves the tab (and the generation its exit reported) as it was.
    tab.gen += 1
    tab.spawnedAt = this.now()
    tab.token = token
    tab.resuming = tab.kind === 'claude' && resumeId !== undefined
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private shell(): string {
    return loginShellOf(this.options.loginEnv())
  }

  private projectRoot(projectId: string): string {
    const root = this.options.projectPath(projectId)
    if (!root) throw new Error('unknown project')
    return root
  }

  /** The tab, only if it belongs to `projectId`. */
  private find(projectId: string, tabId: string): Tab | undefined {
    const tab = this.byId.get(tabId)
    return tab && tab.projectId === projectId ? tab : undefined
  }

  /**
   * The tab when it has a terminal (any kind but a page tab), else undefined: every pty-facing call
   * (input, sizes, screen, ack) goes through this, so a new one cannot forget the page tab.
   */
  private terminalTab(projectId: string, tabId: string): Tab | undefined {
    const tab = this.find(projectId, tabId)
    return tab && tab.kind !== 'page' ? tab : undefined
  }

  private require(projectId: string, tabId: string): Tab {
    const tab = this.find(projectId, tabId)
    if (!tab) throw new Error('unknown tab')
    return tab
  }

  /** Call the terminal tap, if any; a throwing one is logged like a lifecycle listener. */
  private tap(call: (tap: TerminalTap) => void): void {
    const tap = this.options.terminalTap
    if (!tap) return
    try {
      call(tap)
    } catch (err) {
      this.log(`terminal tap failed: ${errorText(err)}`)
    }
  }

  /**
   * `why` is the room registry's: `closed` ends a membership (the person's or a plugin's close, a
   * clean exit closing the tab), `gone` keeps it (the window closed).
   */
  private remove(tab: Tab, why: 'closed' | 'gone'): void {
    // The desktop's flow first: the tap's close ends the tab's joins and releases it, and a desktop
    // still held then would try to rejoin a closed tab and log a stale screen that nobody sees.
    this.desktop.closed(tab.id)
    this.pendingTake.delete(tab.id)
    this.sizes.tabGone(tab.id)
    this.desktopLocal.delete(tab.id)
    // Terminal tap: the tab's stream ends here (close, a window closing, a clean exit closing it).
    // A page tab never had one.
    if (tab.kind !== 'page') this.tap((t) => t.closed(tab.id))
    this.notify((l) => l.closed?.(tab.id))
    this.roomTabGone(tab, why)
    this.byId.delete(tab.id)
    const tabs = this.order.get(tab.projectId)
    if (!tabs) return
    const i = tabs.indexOf(tab)
    if (i >= 0) tabs.splice(i, 1)
    if (tabs.length === 0) this.order.delete(tab.projectId)
  }

  /** Tell restore.ts the saved shape of this project's tabs is stale (a throwing listener is logged). */
  private changed(projectId: string): void {
    try {
      this.options.onTabsChanged?.(projectId)
    } catch (err) {
      this.log(`tab change listener failed: ${errorText(err)}`)
    }
  }

  private notify(call: (lifecycle: TabLifecycle) => void): void {
    const lifecycle = this.options.lifecycle
    if (!lifecycle) return
    try {
      call(lifecycle)
    } catch (err) {
      this.log(`tab lifecycle listener failed: ${errorText(err)}`)
    }
  }

  private onData(id: string, data: string): void {
    const tab = this.byId.get(id)
    if (!tab) return
    // While main consumes the pty, the desktop gets it only when it is keeping up (DesktopFlow).
    if (this.desktop.data(id, data)) this.options.emit(tab.projectId, 'tabs.data', { tabId: id, data })
    // Terminal tap: the same chunk, right after the renderer's, so both see one order.
    this.tap((t) => t.data(id, data))
    if (tab.kind === 'claude') this.notify((l) => l.output?.(id, data))
  }

  private onExit(id: string, code: number, signal: number | null): void {
    const tab = this.byId.get(id)
    // A closed tab's process dies after the tab is gone; nobody is left to tell.
    if (!tab) return
    tab.exit = { code, signal }
    // A resumed Claude that failed before it ever reported a SessionStart may have refused the
    // id ("No conversation found": a record from before `resumable` existed, a transcript the user
    // deleted), so Restart starts fresh instead of failing the same way forever. But the same
    // failure comes from a `claude` that never ran (not on PATH) or hooks that never report, so
    // the saved id is kept, and no change is reported: the next launch tries it again, and only a
    // fresh process's SessionStart replaces it (Tab.resumeFailed). A normal quit exits 0 and
    // changes nothing; a signal death counts as a failure (exitStatus).
    if (tab.resuming && exitStatus(code, signal) !== 0) {
      tab.resuming = false
      tab.resumeFailed = true
      this.log(`tab ${id}: claude --resume failed before the session started; Restart starts fresh`)
    }
    this.notify((l) => l.exited?.(id, code, signal))
    this.log(`tab ${id} (${tab.kind}) exited: code ${code}${signal === null ? '' : `, signal ${signal}`}`)
    if (this.closesOnExit(tab, code, signal)) {
      // Exited, then closed: the session registry (and `ccc sessions`, plugin `sessions` events)
      // see the session end and then go, as when the user closes an exited tab. No `tabs.exit`
      // for the renderer, whose banner would flash for one frame: `tabs.removed` instead.
      this.closeTab(tab)
      this.options.emit(tab.projectId, 'tabs.removed', { tabId: id, gen: tab.gen })
      return
    }
    this.options.emit(tab.projectId, 'tabs.exit', { tabId: id, code, signal, gen: tab.gen })
  }

  /**
   * Whether this exit closes the tab (TabManagerOptions.closeOnCleanExit), by kind. Always
   * exitStatus, not the raw code, because node-pty can report a signal death as code 0.
   * - shell: any exit code closes (a shell reports its last command, not how it ended, see
   *   SHELL_MIN_LIFE_MS), except a signal death or an exit within SHELL_MIN_LIFE_MS of the spawn:
   *   those keep the banner.
   * - claude, command: only code 0 without a signal; a failure keeps its banner so it stays
   *   visible (a crashed `npm run dev` keeps its output).
   * A Claude tab whose `--resume` has not reported a SessionStart yet (still `resuming`, or
   * `resumeFailed` from an earlier attempt) is kept even on exit 0: closing drops it from the
   * saved record, and with it the saved session id that only a replacement process's SessionStart
   * may drop (Tab.resumeFailed). Stale exits never get here: PtyService drops the exit of a
   * process a restart has replaced, so a late exit of an older generation cannot close the
   * restarted tab.
   */
  private closesOnExit(tab: Tab, code: number, signal: number | null): boolean {
    if (tab.kind === 'shell') {
      if (signal !== null) return false
      if (this.now() - tab.spawnedAt < (this.options.shellMinLifeMs ?? SHELL_MIN_LIFE_MS)) return false
    } else if (exitStatus(code, signal) !== 0 || tab.resuming || tab.resumeFailed) {
      return false
    }
    try {
      return this.options.closeOnCleanExit?.() === true
    } catch (err) {
      this.log(`close-on-exit check failed: ${errorText(err)}`)
      return false
    }
  }
}

function tabEvent(tab: Tab): TabEvent {
  return {
    tabId: tab.id,
    projectId: tab.projectId,
    kind: tab.kind,
    cwd: tab.cwd,
    ...(tab.name === undefined ? {} : { name: tab.name }),
    ...(tab.flag === undefined ? {} : { flag: { ...tab.flag } }),
    ...(tab.room === undefined ? {} : { room: { ...tab.room } }),
    ...(tab.restoredMember ? { typed: true as const } : {})
  }
}

/** Reports `sessionId` only once it is resumable: that is what restore saves and resumes. */
function info(tab: Tab): TabInfo {
  const out: TabInfo = { id: tab.id, kind: tab.kind, cwd: tab.cwd, gen: tab.gen }
  if (tab.sessionId !== undefined && tab.resumable) out.sessionId = tab.sessionId
  if (tab.exit) out.exit = { ...tab.exit }
  if (tab.gen === 0) out.notStarted = true
  if (tab.name !== undefined) out.name = tab.name
  if (tab.flag !== undefined) out.flag = { ...tab.flag }
  if (tab.room !== undefined) out.room = { ...tab.room }
  if (tab.typedBy !== undefined) out.typedBy = { ...tab.typedBy }
  if (tab.page) out.page = pageCopy(tab.page)
  if (tab.unseen) out.unseen = true
  if (tab.dirtyIn !== undefined) out.dirty = true
  if (tab.command) {
    out.label = tab.command.label
    if (isPluginCommand(tab.command)) {
      // No `command` for a plugin's tab: there is no command line, and a joined argv in that field
      // would read (and be saved) as one the shell runs. The renderer shows the argv itself.
      out.argv = [...tab.command.argv]
      out.openedBy = tab.command.openedBy
      if (tab.command.openedByName !== undefined) out.openedByName = tab.command.openedByName
    } else {
      out.command = tab.command.command
    }
  }
  return out
}

/** A copy a caller may keep or change: params are plain JSON (checkPageTabSpec), so a JSON round trip is exact. */
function pageCopy(page: PageTabSpec): PageTabSpec {
  const out: PageTabSpec = { plugin: page.plugin, type: page.type, title: page.title }
  if (page.params !== undefined) out.params = JSON.parse(JSON.stringify(page.params)) as PageTabSpec['params']
  if (page.icon !== undefined) out.icon = page.icon
  return out
}

/**
 * The tab's own copy of an entry, re-checked: the caller read it from a settings file or a saved
 * tab record, both user-writable, and a NUL would cut the argv element short. A plugin's argv is
 * re-checked by the same rule host-api applied (checkCommandArgv) and its id by the manifest's;
 * a name that fails the label rule is dropped, not the tab (the tab then shows the bare id).
 */
function tabCommand(entry: TabCommand): TabCommand
function tabCommand(entry: PluginTabCommand): PluginTabCommand
function tabCommand(entry: AnyTabCommand): AnyTabCommand
function tabCommand(entry: AnyTabCommand): AnyTabCommand {
  const label = checkTabCommandLabel(entry.label)
  if (!label.ok) throw new Error(label.reason)
  if (isPluginCommand(entry)) {
    const argv = checkCommandArgv(entry.argv)
    if (!argv.ok) throw new Error(argv.reason)
    if (!isPluginId(entry.openedBy)) throw new Error('a plugin command tab needs the id of its plugin')
    const name = entry.openedByName === undefined ? undefined : checkTabCommandLabel(entry.openedByName)
    return {
      label: label.value,
      argv: argv.value,
      openedBy: entry.openedBy,
      ...(name?.ok ? { openedByName: name.value } : {})
    }
  }
  const command = checkTabCommandLine(entry.command)
  if (!command.ok) throw new Error(command.reason)
  return { label: label.value, command: command.value }
}

/** A plugin id as the manifest allows it (shared/manifest.ts): what openedBy must look like. */
export function isPluginId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PLUGIN_ID_MAX_LENGTH && PLUGIN_ID_PATTERN.test(value)
}

function requireCommand(tab: Tab): AnyTabCommand {
  if (!tab.command) throw new Error('a command tab without a command')
  return tab.command
}

/**
 * What a command tab spawns: a plugin's argv verbatim (a copy; no shell, so nothing in it is ever
 * shell text), else the person's command line through their login shell (commandArgv).
 */
function commandArgvOf(shell: string, command: AnyTabCommand): string[] {
  return isPluginCommand(command) ? [...command.argv] : commandArgv(shell, command.command)
}

/**
 * The directory a tab may start in: the project folder (default) or a directory inside it.
 * Symlinks are resolved on both sides first, so a link inside the project that points outside is
 * refused too. (A link swapped in between this check and the spawn is not defended against; the
 * user owns the folder.)
 */
export function resolveCwd(projectRoot: string, cwd: string | undefined): string {
  if (cwd !== undefined && typeof cwd !== 'string') throw new Error('cwd must be a string')
  let root: string
  let target: string
  try {
    root = realpathSync(projectRoot)
  } catch {
    throw new Error('project folder does not exist')
  }
  try {
    target = realpathSync(resolve(root, cwd || '.'))
  } catch {
    throw new Error('cwd does not exist')
  }
  const rel = relative(root, target)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('cwd is outside the project')
  }
  if (!statSync(target).isDirectory()) throw new Error('cwd is not a directory')
  return target
}
