// Restore (Task 22): save each project's tabs as they change, and bring them back at the next
// start. No Electron import: the registry and the tab manager come in through small interfaces
// so vitest drives all of it with temp dirs and fakes.
//
// What is saved: per project, the tabs in order (kind, cwd, Claude session id, name, flag, room, env) in
// `projects/<id>.json`; which windows were open is `openProjects` in app.json (the window manager
// already keeps it). What comes back: Claude tabs with `claude --resume <id>` (no id yet = a
// fresh `claude`), shell tabs fresh, command tabs NOT started (their own saved command waits for
// the user's Restart; TabManager.restoreTab). A command tab a plugin opened (ctx.sessions.openCommand)
// comes back the same way, but only while that plugin is still installed and not revoked: the check
// is injected (`PluginAvailable`), so this file stays free of the installer and the marketplace.
// A page tab (design-editor.md §1) comes back with its plugin, type, params, title and icon, checked
// again, and only while its plugin is installed and not revoked (the plan) and, right before it is
// put back, still on in the project and declaring the type (`PageTabAvailable`); at most
// MAX_PAGE_TABS_PER_PLUGIN per plugin. Its page is asked for its content (ctx.tabs.onOpen) only when
// a view mounts it, never at restore.
// A running tool call does not survive (design: Restore).
//
// Split groups (design.md §3 "Split groups") are saved beside the tabs, in the same write
// (`ProjectRecord.tabGroups`), their leaves naming the saved `TabRecord.id`s. A restored tab gets a
// new id, so a restore maps each saved id to its new tab (`savedId` → the spawned tab's id) and hands
// the saved groups and that map to main's TabGroups (`restoreGroups`), which prunes the leaves whose
// tab did not come back (a plugin command tab dropped, a failed spawn) before the desktop's
// `tabs.list` reply. The groups are user-writable data like the rest of the record: only
// shared/tab-groups.ts `restoreGroups` reads them, leniently and capped.
//
// Tabs are started when the window's renderer first asks for them (`tabs.list`), not when the
// window is created: output a PTY prints before the page subscribed to `tabs.data` is dropped,
// so a shell started early would show a blank terminal until the next keystroke.
import { randomUUID } from 'node:crypto'
import { errorText } from '../shared/error-text'
import type { TabInfo } from '../shared/ipc'
import { checkSessionName } from '../shared/session-name'
import { savedSessionEnv } from '../shared/session-options'
import { tabFlagOf, type TabFlag } from '../shared/tab-flag'
import { tabRoomOf, type TabRoom } from '../shared/tab-room'
import { checkCommandArgv, checkTabCommandLabel, checkTabCommandLine } from '../shared/tab-commands'
import { checkPageTabSpec, MAX_PAGE_TABS_PER_PLUGIN, type PageTabSpec } from '../shared/page-tabs'
import type { TabGroup } from '../shared/tab-groups'
import type { ProjectView, TabKind, TabRecord } from '../shared/types'
import { ProjectRefusal, type ProjectRegistry } from './projects/registry'
import { SESSION_ID } from './tabs/claude-argv'
import { isPluginCommand, isPluginId, resolveCwd, type AnyTabCommand } from './tabs/tab-manager'
import { warnLog } from './warn-log'

/** One tab to start, as TabManager.restoreTab takes it. */
export interface RestoredTab {
  /**
   * The saved record's id, which the saved groups' leaves name (absent for a record without a usable
   * one: its tab comes back, outside any group). Never the restored tab's id: that is new.
   */
  savedId?: string
  kind: TabKind
  /** Absent = the project folder. */
  cwd?: string
  /** Claude tabs only; absent = a fresh session. */
  resumeId?: string
  /** Claude tabs only: the name the person gave the tab. */
  name?: string
  /**
   * Claude tabs only: the extra environment a plugin opened the tab with, the entries still on the
   * allowlist (savedSessionEnv); TabManager.restoreTab reads it again.
   */
  env?: Record<string, string>
  /** Command tabs only (and always): the tab's own saved copy of its entry, or a plugin's argv. */
  command?: AnyTabCommand
  /** Any kind: the person's flag, sticky across a restart like the tab itself. */
  flag?: TabFlag
  /**
   * Claude tabs only: the room membership and the person's mark (design-rooms.md §1 "Restart"). A
   * quit or a window close keeps it; TabManager.restoreTab keeps it only when the room registry
   * still has that member, under the tab's new id.
   */
  room?: TabRoom
  /** Page tabs only (and always): plugin, type, params, title, icon, checked (checkPageTabSpec). */
  page?: PageTabSpec
}

/**
 * Whether the plugin that opened a command tab may have it back: installed (in the plugin index)
 * and not revoked by a marketplace with authority over it (index.ts asks the installer). A plugin
 * that was uninstalled, or whose commit was revoked, loses its saved tabs: a revoked plugin's argv
 * is exactly what must not sit one Restart click away under its name.
 */
export type PluginAvailable = (pluginId: string) => boolean

/**
 * Whether a saved page tab may come back in `projectId` right now: its plugin loaded, is on in the
 * project (a plugin switched off there, or off in all projects, has no host to answer the page) and
 * still declares `type` in `contributes.tabs` (an update may have dropped it; main never loads a page
 * the manifest does not name). `'later'`: the plugin is installed but cannot have it back right now
 * (it failed to load, its manifest caught mid-update, switched off): the tab stays in the record for
 * the next launch, as a tab that failed to start does. False: gone for good (not installed, or loaded
 * and no longer declaring the type).
 */
export type PageTabAvailable = (projectId: string, pluginId: string, type: string) => boolean | 'later'

/** The persisted shape of live tabs. Ids are saved for the record but a restored tab gets a new one. */
export function tabRecordsOf(tabs: readonly TabInfo[]): TabRecord[] {
  return tabs.map((t) => {
    const record: TabRecord = { id: t.id, kind: t.kind, cwd: t.cwd }
    if (t.sessionId !== undefined) record.sessionId = t.sessionId
    // The tab's copy, not the menu entry: restore must bring back what this tab ran, even when
    // the entry was edited or deleted since.
    if (t.label !== undefined) record.label = t.label
    if (t.command !== undefined) record.command = t.command
    if (t.argv !== undefined) record.argv = [...t.argv]
    if (t.openedBy !== undefined) record.openedBy = t.openedBy
    if (t.openedByName !== undefined) record.openedByName = t.openedByName
    if (t.name !== undefined) record.name = t.name
    if (t.env !== undefined) record.env = { ...t.env }
    if (t.flag !== undefined) record.flag = t.flag.note === undefined ? { color: t.flag.color } : { color: t.flag.color, note: t.flag.note }
    if (t.room !== undefined) record.room = { id: t.room.id, name: t.room.name, coordinator: t.room.coordinator, mark: t.room.mark }
    if (t.page !== undefined) Object.assign(record, pageRecordFields(t.page))
    return record
  })
}

/** A page tab's fields of its saved record (flat, beside kind and cwd). The unseen dot is never saved. */
function pageRecordFields(page: PageTabSpec): Pick<TabRecord, 'plugin' | 'type' | 'params' | 'title' | 'icon'> {
  const out: Pick<TabRecord, 'plugin' | 'type' | 'params' | 'title' | 'icon'> = { plugin: page.plugin, type: page.type, title: page.title }
  if (page.params !== undefined) out.params = page.params
  if (page.icon !== undefined) out.icon = page.icon
  return out
}

/**
 * The tabs to start for a project from its saved records, in saved order.
 *
 * The file is user-writable and its session ids come from hook payloads, so every field is
 * checked rather than trusted:
 *  - an unknown kind is skipped (a record from a newer version);
 *  - a session id that is not a plain token (SESSION_ID) is dropped, which makes that Claude tab
 *    start fresh: the id ends up as the value after `--resume`, where one starting with `-`
 *    would be read as an option;
 *  - a shell tab never resumes anything, whatever its record says;
 *  - a command tab without a valid label and command (checkTabCommandLabel / checkTabCommandLine)
 *    is skipped: there is nothing safe to show or run. A valid one comes back not started;
 *  - a plugin's command tab (a record with `argv` or `openedBy`) needs a valid label, argv
 *    (checkCommandArgv) and plugin id, and no `command`: a record with both is damaged, and must
 *    never fall back to running a line through the shell. It is skipped too when `pluginAvailable`
 *    says its plugin is gone or revoked. A damaged name only loses the name. Not started, as above;
 *  - a page tab needs a valid plugin id, type and title (checkPageTabSpec: params plain JSON under
 *    the cap, a title clamped, a bad icon dropped) and no session or command fields; it is skipped
 *    when `pluginAvailable` says its plugin is gone or revoked, and past MAX_PAGE_TABS_PER_PLUGIN of
 *    one plugin (a hand-edited record cannot pile more into the bar than an open could);
 *  - a cwd that is gone, is not a directory or is outside the project (the project was relinked
 *    to another folder, a symlink now points out) falls back to the project folder. The tab is
 *    still worth bringing back, and the user can see where it is.
 */
export function buildRestorePlan(
  project: Pick<ProjectView, 'path' | 'tabs'>,
  pluginAvailable?: PluginAvailable,
  log?: (message: string) => void
): RestoredTab[] {
  const plan: RestoredTab[] = []
  const records: unknown = project.tabs
  if (!Array.isArray(records)) return plan
  const pagesOf = new Map<string, number>()
  for (const raw of records as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const { kind, cwd, sessionId, label, command, argv, openedBy, openedByName, name, flag, room, env } = raw as Record<string, unknown>
    if (kind === 'page') {
      const page = pagePlanOf(raw as Record<string, unknown>)
      if (page === undefined) continue
      if (pluginAvailable !== undefined && !available(pluginAvailable, page.plugin)) continue
      const count = pagesOf.get(page.plugin) ?? 0
      if (count >= MAX_PAGE_TABS_PER_PLUGIN) continue
      pagesOf.set(page.plugin, count + 1)
      const tab: RestoredTab = { kind, page }
      // A page leaf of a saved group maps through the id map like any tab (design-split-pages.md).
      const pid = (raw as Record<string, unknown>).id
      if (typeof pid === 'string' && pid.length > 0 && pid.length <= MAX_SAVED_ID) tab.savedId = pid
      const f = tabFlagOf(flag)
      if (f !== undefined) tab.flag = f
      plan.push(tab)
      continue
    }
    if (kind !== 'claude' && kind !== 'shell' && kind !== 'command') continue
    const tab: RestoredTab = { kind }
    const id = (raw as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0 && id.length <= MAX_SAVED_ID) tab.savedId = id
    if (kind === 'command') {
      const l = checkTabCommandLabel(label)
      if (!l.ok) continue
      if (argv !== undefined || openedBy !== undefined) {
        const a = checkCommandArgv(argv)
        if (!a.ok || command !== undefined || !isPluginId(openedBy)) continue
        if (pluginAvailable !== undefined && !available(pluginAvailable, openedBy)) continue
        const n = openedByName === undefined ? undefined : checkTabCommandLabel(openedByName)
        tab.command = { label: l.value, argv: a.value, openedBy, ...(n?.ok ? { openedByName: n.value } : {}) }
      } else {
        const c = checkTabCommandLine(command)
        if (!c.ok) continue
        tab.command = { label: l.value, command: c.value }
      }
    }
    if (typeof cwd === 'string' && cwdUsable(project.path, cwd)) tab.cwd = cwd
    if (kind === 'claude' && typeof sessionId === 'string' && SESSION_ID.test(sessionId)) {
      tab.resumeId = sessionId
    }
    // A saved name that fails the rule is dropped, not the tab: the file is user-writable.
    if (kind === 'claude' && name !== undefined) {
      const n = checkSessionName(name)
      if (n.ok && n.value !== null) tab.name = n.value
    }
    // Membership is a Claude tab's only; a damaged one is dropped, not the tab (tabRoomOf).
    if (kind === 'claude') {
      const r = tabRoomOf(room)
      if (r !== undefined) tab.room = r
    }
    // A Claude tab's env, checked with the open's allowlist: an entry no longer on it (the list
    // changed, or the file was edited) is dropped and logged, never applied; the tab comes back with
    // the rest. Another kind's env is ignored: a shell or command tab never takes one.
    if (kind === 'claude') {
      const e = savedSessionEnv(env)
      if (e.dropped.length > 0) log?.(`restore: a Claude tab's env dropped (not allowed): ${e.dropped.join(', ')}`)
      if (e.env !== undefined) tab.env = { ...e.env }
    }
    // Any kind keeps its flag; a damaged one is dropped, not the tab (tabFlagOf).
    const f = tabFlagOf(flag)
    if (f !== undefined) tab.flag = f
    plan.push(tab)
  }
  return plan
}

/**
 * A saved page tab's spec, or undefined when the record is damaged: any session or command field
 * on it (a record mixing kinds is never guessed at), or a spec checkPageTabSpec refuses.
 */
function pagePlanOf(raw: Record<string, unknown>): PageTabSpec | undefined {
  for (const key of ['sessionId', 'label', 'command', 'argv', 'openedBy', 'openedByName', 'name', 'env']) {
    if (raw[key] !== undefined) return undefined
  }
  try {
    return checkPageTabSpec({ plugin: raw.plugin, type: raw.type, params: raw.params, title: raw.title, icon: raw.icon }, isPluginId)
  } catch {
    return undefined
  }
}

function startedId(started: unknown): string | undefined {
  if (typeof started !== 'object' || started === null) return undefined
  const id = (started as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/** A saved tab id longer than this names no group leaf (main's are UUIDs). */
const MAX_SAVED_ID = 64

/** The injected check, a throw read as "not available": a tab is dropped rather than kept on a guess. */
function available(check: PluginAvailable, pluginId: string): boolean {
  try {
    return check(pluginId)
  } catch {
    return false
  }
}

function cwdUsable(projectPath: string, cwd: string): boolean {
  try {
    resolveCwd(projectPath, cwd)
    return true
  } catch {
    return false
  }
}

/** What to do at launch with the projects whose windows were open at last quit. */
export interface LaunchPlan {
  /** Folder is there: open a window, then start these tabs when its renderer attaches. */
  open: Array<{ project: ProjectView; tabs: RestoredTab[]; groups: unknown }>
  /** Folder is gone: no window; the picker offers relink or forget (Task 22). */
  missing: ProjectView[]
}

export function planLaunch(projects: readonly ProjectView[], pluginAvailable?: PluginAvailable, log?: (message: string) => void): LaunchPlan {
  const plan: LaunchPlan = { open: [], missing: [] }
  for (const project of projects) {
    if (project.missing) plan.missing.push(project)
    else plan.open.push({ project, tabs: buildRestorePlan(project, pluginAvailable, log), groups: project.tabGroups })
  }
  return plan
}

export interface TabRestorerOptions {
  /** The project's live tabs (TabManager.list). */
  listTabs(projectId: string): TabInfo[]
  /**
   * Write the records and the split groups into the project's store in one update
   * (ProjectRegistry.update, debounced): a group on disk must never name tabs of another save.
   */
  saveTabs(projectId: string, records: TabRecord[], groups: TabGroup[]): void
  /** The project's split groups now (TabGroups.groupsOf), their leaves the live tab ids. Absent = none. */
  listGroups?(projectId: string): TabGroup[]
  /**
   * After a restore spawned its tabs: the saved groups (untrusted, as read from the record) and the
   * map from each saved tab id to its restored tab's new id (TabGroups.restore). Called once per
   * restore run, also with no groups (the views still owe the restored order). Absent = groups are
   * not restored (tests that do not care).
   */
  restoreGroups?(projectId: string, saved: unknown, idMap: ReadonlyMap<string, string>): void
  /** The project's folder (ProjectRegistry.get): the cwd saved for a tab that failed to restore. */
  projectPath(projectId: string): string | undefined
  /**
   * Whether a plugin command tab's plugin may have it back (PluginAvailable). Asked when a plan is
   * built here (requeue) and again right before the queued tabs start: the plan of a launch was
   * made before the window attached, and the plugin may have been uninstalled or revoked since.
   * Absent = every plugin is (tests that do not care).
   */
  pluginAvailable?: PluginAvailable
  /**
   * Whether a page tab may come back now (PageTabAvailable), asked right before the queued tabs are
   * put back: the plugin list is loaded by then, and the plugin may have been switched off since the
   * plan was made. Absent = every page tab may (tests that do not care).
   */
  pageTabAvailable?: PageTabAvailable
  log?: (message: string) => void
}

/**
 * Keeps the saved tabs of every project in step with the live ones, and runs the pending restores.
 */
export class TabRestorer {
  private readonly pending = new Map<string, { tabs: RestoredTab[]; groups: unknown }>()
  private readonly running = new Map<string, Promise<void>>()
  // Saved tabs whose restore threw (spawn failed: out of ptys, the folder vanished meanwhile).
  // Every save rewrites the record from the live tabs, so without these that save would drop the
  // tab and its Claude session id for good, the same loss a failed `--resume` must not cause
  // (TabManager, Tab.resumeFailed). They ride along in every save until the window is closed, so
  // the next launch tries them again; while the window lives the user has no tab to restart them.
  private readonly unrestored = new Map<string, TabRecord[]>()
  // Bumped when the window is closed (clear/discard). A run that is still waiting for `ready`
  // compares it before spawning: tabs started for a window that is already gone would be PTYs
  // outliving their window, and would write themselves back into the record just cleared.
  private readonly generation = new Map<string, number>()
  private frozen = false
  private readonly log: (message: string) => void

  constructor(private readonly options: TabRestorerOptions) {
    this.log = options.log ?? warnLog
  }

  /**
   * Tabs to start when this project's renderer first attaches, with the saved split groups over
   * their saved ids (the record's `tabGroups`, unread). Replaces an earlier plan.
   */
  queue(projectId: string, tabs: RestoredTab[], groups?: unknown): void {
    if (tabs.length > 0) this.pending.set(projectId, { tabs, groups })
    else this.pending.delete(projectId)
  }

  /** Forget a plan (the window was closed or the project relinked before it attached). */
  discard(projectId: string): void {
    this.pending.delete(projectId)
    this.unrestored.delete(projectId)
    this.generation.set(projectId, (this.generation.get(projectId) ?? 0) + 1)
  }

  hasPending(projectId: string): boolean {
    return this.pending.has(projectId)
  }

  /**
   * Start the project's queued tabs through `spawn`, once. Takes the plan synchronously, so a
   * second attach (a page reload) that arrives while `ready` is awaited waits for the same run
   * instead of starting the tabs twice. A tab that fails to start is logged and skipped, the rest
   * still come back. The saved records are rewritten afterwards from what actually runs, plus the
   * tabs that failed (see `unrestored`).
   */
  restore(projectId: string, ready: Promise<unknown>, spawn: (tab: RestoredTab) => unknown): Promise<void> {
    const plan = this.pending.get(projectId)
    if (plan) {
      const { tabs, groups } = plan
      this.pending.delete(projectId)
      const startedAt = this.generation.get(projectId) ?? 0
      const run = ready.then(() => {
        // The window was closed (or the plan discarded) while the login env was captured.
        if ((this.generation.get(projectId) ?? 0) !== startedAt) return
        const failed: TabRecord[] = []
        // Saved id → restored tab id, for the saved groups' leaves.
        const idMap = new Map<string, string>()
        for (const tab of tabs) {
          // Dropped, not failed: a failed tab rides along in the record to be tried again, and a
          // gone plugin's tab must leave the record for good.
          if (tab.command !== undefined && isPluginCommand(tab.command) && !this.pluginOk(tab.command.openedBy)) {
            this.log(`not restoring a command tab of project ${projectId}: plugin ${tab.command.openedBy} is gone or revoked`)
            continue
          }
          if (tab.page !== undefined) {
            const ok = this.pageOk(projectId, tab.page)
            if (ok === 'later') {
              // A passing state (a failed load, an update under way, the plugin off here for now)
              // must not cost the person their open tabs: kept as a failed tab is, tried next launch.
              this.log(`not restoring a page tab of project ${projectId} now: plugin ${tab.page.plugin} is off or did not load; it is kept for the next launch`)
              const record = this.failedRecord(projectId, tab)
              if (record) failed.push(record)
              continue
            }
            if (!ok) {
              this.log(`not restoring a page tab of project ${projectId}: plugin ${tab.page.plugin} is gone or no longer has type "${tab.page.type}"`)
              continue
            }
          }
          try {
            // The started tab (TabManager.restoreTab's TabInfo): its new id is what the leaves become.
            const id = startedId(spawn(tab))
            if (id !== undefined && tab.savedId !== undefined && !idMap.has(tab.savedId)) idMap.set(tab.savedId, id)
          } catch (err) {
            this.log(
              `cannot restore a ${tab.kind} tab of project ${projectId}: ${errorText(err)}`
            )
            const record = this.failedRecord(projectId, tab)
            if (record) failed.push(record)
          }
        }
        if (failed.length > 0) this.unrestored.set(projectId, failed)
        // Before the save below and before the attach answers (the desktop's `tabs.list` reply comes
        // after this run): the groups are in place when any view first draws the tabs. A throw
        // costs the groups only, never the restored tabs.
        try {
          this.options.restoreGroups?.(projectId, groups, idMap)
        } catch (err) {
          this.log(`cannot restore the split groups of project ${projectId}: ${errorText(err)}`)
        }
        this.tabsChanged(projectId)
      })
      const done = run.finally(() => {
        if (this.running.get(projectId) === done) this.running.delete(projectId)
      })
      this.running.set(projectId, done)
      return done
    }
    return this.running.get(projectId) ?? Promise.resolve()
  }

  /** The live tabs of a project changed: save them. A no-op after `freeze`. */
  tabsChanged(projectId: string): void {
    if (this.frozen) return
    // Failed tabs go last: their place among the live tabs is not known, and order is cosmetic.
    const records = tabRecordsOf(this.options.listTabs(projectId))
    this.options.saveTabs(projectId, [...records, ...(this.unrestored.get(projectId) ?? [])], this.groupsOf(projectId))
  }

  /**
   * The saved form of a tab that did not start. A restored tab gets a new id anyway, so a fresh
   * one is fine; the cwd absent from the plan means the project folder (buildRestorePlan), which
   * has to be written out. Without a folder there is nothing valid to save: the tab is dropped.
   */
  private failedRecord(projectId: string, tab: RestoredTab): TabRecord | undefined {
    const cwd = tab.cwd ?? this.options.projectPath(projectId)
    if (cwd === undefined) return undefined
    const record: TabRecord = { id: randomUUID(), kind: tab.kind, cwd }
    if (tab.resumeId !== undefined) record.sessionId = tab.resumeId
    if (tab.name !== undefined) record.name = tab.name
    if (tab.env !== undefined) record.env = { ...tab.env }
    if (tab.flag !== undefined) record.flag = { ...tab.flag }
    if (tab.room !== undefined) record.room = { ...tab.room }
    if (tab.page !== undefined) Object.assign(record, pageRecordFields(tab.page))
    if (tab.command !== undefined) {
      record.label = tab.command.label
      if (isPluginCommand(tab.command)) {
        record.argv = [...tab.command.argv]
        record.openedBy = tab.command.openedBy
        if (tab.command.openedByName !== undefined) record.openedByName = tab.command.openedByName
      } else {
        record.command = tab.command.command
      }
    }
    return record
  }

  private pageOk(projectId: string, page: PageTabSpec): boolean | 'later' {
    const check = this.options.pageTabAvailable
    if (check === undefined) return true
    try {
      const ok = check(projectId, page.plugin, page.type)
      return ok === 'later' ? 'later' : ok === true
    } catch {
      // Unknown: kept, not dropped for good.
      return 'later'
    }
  }

  private pluginOk(pluginId: string): boolean {
    const check = this.options.pluginAvailable
    return check === undefined || available(check, pluginId)
  }

  /**
   * The project's window is being closed to be opened again at once (WindowManager.reopen, to
   * apply a creation-only window setting): its tabs come back in the new window as after a
   * restart. Call it while the tabs are still live, before the close kills them: the records are
   * taken from them right now, not from the debounced save, so a session id or a reorder that
   * came in a moment ago is not lost. They are saved (the record stays what a crash or quit would
   * restore) and queued for the new window's first attach, which is what a launch does.
   *
   * - A plan still pending (the window never attached) stays as it is: no tab started, the live
   *   list is empty, and the plan is exactly what is still to come.
   * - Tabs whose restore failed (`unrestored`) go into the plan, so the new window tries them
   *   again; they leave `unrestored`, or the new window's saves would carry them twice.
   * - A restore still waiting for `ready` is not cancelled (the generation is not bumped): its
   *   tabs are not in the live list, so the new window gets them from that run and the rest from
   *   this plan, none twice.
   * - After `freeze` (quitting) nothing is saved, as everywhere.
   */
  requeue(projectId: string): void {
    if (this.pending.has(projectId)) return
    const records = [...tabRecordsOf(this.options.listTabs(projectId)), ...(this.unrestored.get(projectId) ?? [])]
    // Their leaves are the live ids, which are the records' ids: the new window maps them like a launch.
    const groups = this.groupsOf(projectId)
    this.unrestored.delete(projectId)
    if (!this.frozen) this.options.saveTabs(projectId, records, groups)
    const path = this.options.projectPath(projectId)
    // Through buildRestorePlan like a launch: the same checks (a cwd that is gone falls back to
    // the folder, a command tab comes back not started, a shell tab never resumes).
    this.queue(projectId, path === undefined ? [] : buildRestorePlan({ path, tabs: records }, this.options.pluginAvailable, this.log), groups)
  }

  /** The user closed the project's window: its tabs are gone for good, so is their record. */
  clear(projectId: string): void {
    this.discard(projectId)
    if (this.frozen) return
    this.options.saveTabs(projectId, [], [])
  }

  /** The live groups, a throwing source read as none (the tabs are still saved). */
  private groupsOf(projectId: string): TabGroup[] {
    try {
      return this.options.listGroups?.(projectId) ?? []
    } catch (err) {
      this.log(`cannot read the split groups of project ${projectId}: ${errorText(err)}`)
      return []
    }
  }

  /**
   * App quit: keep what is saved. Quitting closes every window, which kills every tab, and none
   * of that may be written down or the next start would find nothing to restore.
   */
  freeze(): void {
    this.frozen = true
  }
}

/** The registry operations the picker's relink / forget need. */
export type MissingProjectRegistry = Pick<ProjectRegistry, 'recent' | 'relink' | 'forget' | 'update'>

/**
 * A project the picker may act on: in the recent list (the scope a picker window is allowed to
 * touch, like `openRecent`) and with its folder really gone. Relinking or forgetting a project
 * that is fine would be a way to destroy data by a stray click or a forged id.
 */
function missingRecent(registry: Pick<MissingProjectRegistry, 'recent'>, id: string): ProjectView {
  const project = registry.recent().find((p) => p.id === id)
  // Refusals (a server's browser is answered with their text, web/open-project.ts): they say what is
  // wrong with the request, never anything of the data dir.
  if (!project) throw new ProjectRefusal('not a recent project')
  if (!project.missing) throw new ProjectRefusal('the project folder is not missing')
  return project
}

/** Remove a missing project's record (and so its saved tabs). */
export function forgetMissing(registry: MissingProjectRegistry, id: string): void {
  missingRecent(registry, id)
  registry.forget(id)
}

/**
 * Point a missing project at the folder the user chose. Its saved tabs are dropped: a Claude
 * session is stored under the folder it ran in, so `--resume` from another folder would not find
 * it, and the old cwds do not exist there.
 */
export function relinkMissing(
  registry: MissingProjectRegistry,
  id: string,
  newPath: string
): ProjectView {
  missingRecent(registry, id)
  const view = registry.relink(id, newPath)
  registry.update(id, (r) => {
    r.tabs = []
  })
  return { ...view, tabs: [] }
}
