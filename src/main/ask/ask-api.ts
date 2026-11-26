// The Ask API's seam in main (shared/design.md §5, spec-review S5, design-parts.md §7; 00 contract). Task 02 implements
// it in ask-service.ts (argv: ask-argv.ts, spawn: ask-runner.ts, kept chats: ask-store.ts, the pick: ask-pick.ts).
import type { AskPickState } from '../../shared/overlay-envelope'
import type { ViewId } from '../../shared/views'
import type { OverlayManager } from '../overlays/overlay-manager'
import { AskService } from './ask-service'

/**
 * Who may Ask from a view, as main decides it (D1): the owner, or a guest whose live access is write. Undefined for a
 * read guest, a revoked one, an unknown view: they may not Ask, and get no chat pushed.
 */
export type AskPerson = 'owner' | { guest: string }

/** The caller of a channel, as the router bound it: the window, its project, the view and the person. */
export interface AskCaller {
  windowId: number
  projectId: string
  view: ViewId
  /** From the router's `isOwner(view)` / guest access; undefined: refused. */
  person: AskPerson | undefined
}

export interface AskApi {
  /**
   * A token an Ask process was given (S5 A2: `ccc` from an Ask's env): its project, or undefined. Compared in
   * constant time like a tab's (TabManager.resolveToken). The socket treats the caller as a window owner: no
   * shell-only commands, no tab commands.
   */
  resolveToken(token: string): { projectId: string } | undefined
  /** Every chat of the guest ends at once (GuestStore: any access change, the guest's end). In memory only (D14). */
  dropGuest(guestId: string): void
  /** Uninstall: the plugin's stored chats in every project. */
  removePlugin(pluginId: string): void
  /** Project forget: the project's stored chats. */
  dropProject(projectId: string): void
  /** `overlays.ask.start`: a question in the key's chat (Claude starts now; a kept chat resumes). */
  start(caller: AskCaller, req: unknown): Promise<null>
  /** `overlays.ask.say`: a follow-up in the key's chat; refused when there is no chat yet. */
  say(caller: AskCaller, req: unknown): Promise<null>
  /** `overlays.ask.close`: the chat's process ends (the kept turns stay). */
  close(caller: AskCaller, req: unknown): null
  /** `overlays.ask.pick`: read (empty) or set the model and effort; saved app-wide only for the owner. */
  pick(caller: AskCaller, req: unknown): AskPickState
  /** `overlays.ask.continue`: the owner's chat goes on in a Claude tab (D14). */
  continueInTab(caller: AskCaller, req: unknown): Promise<{ tabId: string }>
}

/** What the service gets from main (wired once in index.ts, at the createAskApi call). */
export interface AskApiDeps {
  dataDir: string
  log: (message: string) => void
  overlays: Pick<OverlayManager, 'copyOwner' | 'copiesOf' | 'notesOf' | 'postEnvelope' | 'onCopyReady' | 'onCopyEnd' | 'partsOf' | 'askContext' | 'openerPluginOf' | 'infos'>
  /** The project's folder from main's record (Ask's cwd, never a payload's), or undefined for an unknown project. */
  projectRoot(projectId: string): string | undefined
  /** The project of an open window, or undefined. */
  projectOfWindow(windowId: number): string | undefined
  /** The login env (loadLoginEnv), awaited: Ask runs `claude` on the person's PATH. */
  loginEnv(): Promise<Record<string, string | undefined>>
  /** Who may Ask from a view now (owner, or a write guest's id), read live; a copy's history goes only to such a view. */
  askerOf(view: ViewId): AskPerson | undefined
  /** Open a Claude tab in the project resuming `sessionId` (TabManager.create with resumeId); its tab id. Throws. */
  openResumeTab(projectId: string, sessionId: string): string
}

/** The Ask service. */
export function createAskApi(deps: AskApiDeps): AskApi {
  return new AskService(deps)
}
