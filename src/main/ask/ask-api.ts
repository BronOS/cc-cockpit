// The Ask API's seam in main (shared/design.md §5, spec-review S5, design-parts.md §7; 00 contract). Frozen here; task
// 02 implements it (ask-argv.ts, ask-runner.ts, ask-service.ts, ask-store.ts, ask-pick.ts) and replaces createAskApi's
// body. Until then there is no service: every `overlays.ask.*` call is refused (ipc/ask-handlers.ts), no Ask token
// resolves, and the drops below are no-ops.
import type { OverlayManager } from '../overlays/overlay-manager'

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
}

/** What the service gets from main (wired once in index.ts). Task 02 may ask the lead for more. */
export interface AskApiDeps {
  dataDir: string
  log: (message: string) => void
  overlays: Pick<OverlayManager, 'copyOwner' | 'copiesOf' | 'notesOf' | 'postEnvelope' | 'onCopyReady' | 'onCopyEnd' | 'partsOf'>
  /** The project's folder from main's record (Ask's cwd, never a payload's), or undefined for an unknown project. */
  projectRoot(projectId: string): string | undefined
  /** The project of an open window, or undefined. */
  projectOfWindow(windowId: number): string | undefined
  /** The login env (loadLoginEnv), awaited: Ask runs `claude` on the person's PATH. */
  loginEnv(): Promise<Record<string, string | undefined>>
}

/** The Ask service, or undefined while there is none (00: every caller then refuses). Task 02 fills it. */
export function createAskApi(deps: AskApiDeps): AskApi | undefined {
  void deps
  return undefined
}
