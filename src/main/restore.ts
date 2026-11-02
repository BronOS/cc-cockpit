// Restore (Task 22): save each project's tabs as they change, and bring them back at the next
// start. No Electron import: the registry and the tab manager come in through small interfaces
// so vitest drives all of it with temp dirs and fakes.
//
// What is saved: per project, the tabs in order (kind, cwd, Claude session id) in
// `projects/<id>.json`; which windows were open is `openProjects` in app.json (the window manager
// already keeps it). What comes back: Claude tabs with `claude --resume <id>` (no id yet = a
// fresh `claude`), shell tabs fresh, command tabs NOT started (their own saved command waits for
// the user's Restart; TabManager.restoreTab). A running tool call does not survive (design: Restore).
//
// Tabs are started when the window's renderer first asks for them (`tabs.list`), not when the
// window is created: output a PTY prints before the page subscribed to `tabs.data` is dropped,
// so a shell started early would show a blank terminal until the next keystroke.
import { randomUUID } from 'node:crypto'
import { errorText } from '../shared/error-text'
import type { TabInfo } from '../shared/ipc'
import { checkTabCommandLabel, checkTabCommandLine } from '../shared/tab-commands'
import type { ProjectView, TabKind, TabRecord } from '../shared/types'
import type { ProjectRegistry } from './projects/registry'
import { SESSION_ID } from './tabs/claude-argv'
import { resolveCwd, type TabCommand } from './tabs/tab-manager'

/** One tab to start, as TabManager.restoreTab takes it. */
export interface RestoredTab {
  kind: TabKind
  /** Absent = the project folder. */
  cwd?: string
  /** Claude tabs only; absent = a fresh session. */
  resumeId?: string
  /** Command tabs only (and always): the tab's own saved copy of its entry. */
  command?: TabCommand
}

/** The persisted shape of live tabs. Ids are saved for the record but a restored tab gets a new one. */
export function tabRecordsOf(tabs: readonly TabInfo[]): TabRecord[] {
  return tabs.map((t) => {
    const record: TabRecord = { id: t.id, kind: t.kind, cwd: t.cwd }
    if (t.sessionId !== undefined) record.sessionId = t.sessionId
    // The tab's copy, not the menu entry: restore must bring back what this tab ran, even when
    // the entry was edited or deleted since.
    if (t.label !== undefined) record.label = t.label
    if (t.command !== undefined) record.command = t.command
    return record
  })
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
 *  - a cwd that is gone, is not a directory or is outside the project (the project was relinked
 *    to another folder, a symlink now points out) falls back to the project folder. The tab is
 *    still worth bringing back, and the user can see where it is.
 */
export function buildRestorePlan(project: Pick<ProjectView, 'path' | 'tabs'>): RestoredTab[] {
  const plan: RestoredTab[] = []
  const records: unknown = project.tabs
  if (!Array.isArray(records)) return plan
  for (const raw of records as unknown[]) {
    if (typeof raw !== 'object' || raw === null) continue
    const { kind, cwd, sessionId, label, command } = raw as Record<string, unknown>
    if (kind !== 'claude' && kind !== 'shell' && kind !== 'command') continue
    const tab: RestoredTab = { kind }
    if (kind === 'command') {
      const l = checkTabCommandLabel(label)
      const c = checkTabCommandLine(command)
      if (!l.ok || !c.ok) continue
      tab.command = { label: l.value, command: c.value }
    }
    if (typeof cwd === 'string' && cwdUsable(project.path, cwd)) tab.cwd = cwd
    if (kind === 'claude' && typeof sessionId === 'string' && SESSION_ID.test(sessionId)) {
      tab.resumeId = sessionId
    }
    plan.push(tab)
  }
  return plan
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
  open: Array<{ project: ProjectView; tabs: RestoredTab[] }>
  /** Folder is gone: no window; the picker offers relink or forget (Task 22). */
  missing: ProjectView[]
}

export function planLaunch(projects: readonly ProjectView[]): LaunchPlan {
  const plan: LaunchPlan = { open: [], missing: [] }
  for (const project of projects) {
    if (project.missing) plan.missing.push(project)
    else plan.open.push({ project, tabs: buildRestorePlan(project) })
  }
  return plan
}

export interface TabRestorerOptions {
  /** The project's live tabs (TabManager.list). */
  listTabs(projectId: string): TabInfo[]
  /** Write the records into the project's store (ProjectRegistry.update, debounced). */
  saveTabs(projectId: string, records: TabRecord[]): void
  /** The project's folder (ProjectRegistry.get): the cwd saved for a tab that failed to restore. */
  projectPath(projectId: string): string | undefined
  log?: (message: string) => void
}

/**
 * Keeps the saved tabs of every project in step with the live ones, and runs the pending restores.
 */
export class TabRestorer {
  private readonly pending = new Map<string, RestoredTab[]>()
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
    this.log = options.log ?? ((m) => console.warn(m))
  }

  /** Tabs to start when this project's renderer first attaches. Replaces an earlier plan. */
  queue(projectId: string, tabs: RestoredTab[]): void {
    if (tabs.length > 0) this.pending.set(projectId, tabs)
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
  restore(projectId: string, ready: Promise<unknown>, spawn: (tab: RestoredTab) => void): Promise<void> {
    const tabs = this.pending.get(projectId)
    if (tabs) {
      this.pending.delete(projectId)
      const startedAt = this.generation.get(projectId) ?? 0
      const run = ready.then(() => {
        // The window was closed (or the plan discarded) while the login env was captured.
        if ((this.generation.get(projectId) ?? 0) !== startedAt) return
        const failed: TabRecord[] = []
        for (const tab of tabs) {
          try {
            spawn(tab)
          } catch (err) {
            this.log(
              `cannot restore a ${tab.kind} tab of project ${projectId}: ${errorText(err)}`
            )
            const record = this.failedRecord(projectId, tab)
            if (record) failed.push(record)
          }
        }
        if (failed.length > 0) this.unrestored.set(projectId, failed)
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
    this.options.saveTabs(projectId, [...records, ...(this.unrestored.get(projectId) ?? [])])
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
    if (tab.command !== undefined) {
      record.label = tab.command.label
      record.command = tab.command.command
    }
    return record
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
    this.unrestored.delete(projectId)
    if (!this.frozen) this.options.saveTabs(projectId, records)
    const path = this.options.projectPath(projectId)
    // Through buildRestorePlan like a launch: the same checks (a cwd that is gone falls back to
    // the folder, a command tab comes back not started, a shell tab never resumes).
    this.queue(projectId, path === undefined ? [] : buildRestorePlan({ path, tabs: records }))
  }

  /** The user closed the project's window: its tabs are gone for good, so is their record. */
  clear(projectId: string): void {
    this.discard(projectId)
    if (this.frozen) return
    this.options.saveTabs(projectId, [])
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
  if (!project) throw new Error('not a recent project')
  if (!project.missing) throw new Error('the project folder is not missing')
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
